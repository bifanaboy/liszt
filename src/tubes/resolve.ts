/**
 * Link resolution - the three-rung ladder.
 *
 * For each scene with no live link, a positive duration, and a non-`none`
 * matcher lane, in order:
 *
 *   1. eporner trusted pool   (rung 1, the hot path)
 *   2. sxyprn                 (search, gate the card, then re-fetch and re-gate)
 *   3. eporner open search    (explicit `lq=0`)
 *
 * Otherwise the scene stays unlinked and is retried on a later cycle.
 *
 * THE RULE IS THE SAME ON ALL THREE. Duration band and upload window filter;
 * performer-in-title only ranks. The rule strings below are the only place the
 * rule is written down in prose, and they are deliberately identical in content
 * so a rung cannot quietly drift into being stricter than the others.
 *
 * A source that ERRORS is not a source that found nothing: an error lets the
 * next rung run, and the recorded outcome is a clean no-match only if a rung
 * actually answered. A scene that was never matched still has `videoCheckedAt`
 * stamped so the read model can say when it was last looked at.
 *
 * `confidence` is the winner's IDENTITY TIER, not a date measurement. `low`
 * means the winner carried no identity evidence at all and was chosen on views
 * alone - the decoy path, and exactly the set of links worth eyeballing by
 * hand. A tier of 3, 2 or 1 all read `high`, because a first-name-only match is
 * a real match and flagging it as suspect would swamp the signal.
 *
 * The safety rule is inherited unchanged: a missing link is preferable to a
 * wrong link. No rung writes a URL that did not clear the shared gate, and a
 * URL already in `deadVideoUrls` is never re-added.
 */
import { epornerVideoId, epornerWatchUrl, type EpornerOpenMatch } from "./eporner.ts";
import { validSxyprnUrl, type SxyprnMatch } from "./sxyprn.ts";
import { toMatchScene, type MatchScene, type Rung } from "./types.ts";
import type { PoolMatch } from "./eporner-pool.ts";
import type { IdentityTier } from "../core/matching.ts";
import type { Scene, VideoLink, VideoLinkSource } from "../core/schema.ts";

const RULE_SHAPE =
  "duration within tolerance AND upload date within release-1d..release+window; identity ranks, never gates";

export const POOL_RULE = `trusted-pool: ${RULE_SHAPE}`;
export const SXYPRN_RULE = `sxyprn: ${RULE_SHAPE}; post details verified, not the search card`;
export const OPEN_RULE = `eporner open: lq=0, ${RULE_SHAPE}`;

/** `low` is the decoy path: a winner with no identity evidence, chosen on views. */
function confidenceFor(tier: IdentityTier | undefined): "high" | "low" {
  return tier === 0 || tier === undefined ? "low" : "high";
}

export interface ResolveDeps {
  /** The lane's declared matcher, or null for a metadata-only lane. */
  matcher: string | null;
  creatorStudio: boolean;
  now: Date;
  /** Rung 1. Null when the pool index is unavailable. */
  poolLookup: ((scene: MatchScene, now: Date) => Promise<PoolMatch | null>) | null;
  /** Rung 2. Null when the optional sxyprn client is not installed. */
  sxyprnLookup: ((scene: MatchScene) => Promise<SxyprnMatch[]>) | null;
  /** Rung 3. */
  openLookup: ((scene: MatchScene) => Promise<EpornerOpenMatch[]>) | null;
}

export interface ResolveResult {
  scene: Scene;
  changed: boolean;
  matched: boolean;
  rung: Rung | "none" | null;
  /** The winner's identity tier, or null when nothing matched. */
  tier: IdentityTier | null;
}

/**
 * Why each rung declined, accumulated across a run.
 *
 * The point is the "date unavailable for a whole rung" failure mode, which is
 * invisible in a match count: the rung returns nothing, the ladder quietly
 * falls through, and a mis-tuned window looks exactly like a corpus with no
 * videos. Surfacing rejection counts per rung is what makes the difference
 * visible between "this scene has no video" and "this rung rejected everything".
 */
export interface RungRejections {
  /** Rungs that ran. */
  attempted: number;
  /** Rungs that answered and found nothing. */
  noMatch: number;
  /** Rungs that errored, so the ladder fell through without a clean negative. */
  errored: number;
  /** Candidates rejected for falling outside the upload window. */
  date: number;
  /** Candidates rejected for having no readable upload date at all. */
  unknownDate: number;
  /** Scenes where the duration band left nothing. */
  duration: number;
}

export function emptyRejections(): RungRejections {
  return { attempted: 0, noMatch: 0, errored: 0, date: 0, unknownDate: 0, duration: 0 };
}

/** The scene fields the matchers read, including the creator-studio flag. */
export function buildMatchScene(scene: Scene, creatorStudio: boolean): MatchScene {
  const base = toMatchScene(scene);
  if (creatorStudio) base.creatorStudio = true;
  return base;
}

function linkFor(source: VideoLinkSource, url: string, now: Date): VideoLink {
  return { source, url, verifiedAt: now.toISOString(), verifyFailures: 0 };
}

async function tryPool(
  scene: MatchScene,
  dead: Set<string>,
  deps: ResolveDeps,
  rejections: RungRejections,
): Promise<{ link: VideoLink; tier: IdentityTier } | null> {
  // A rung that is not CONFIGURED is not a rung that errored. Returning here
  // before the counters matter keeps "this source is switched off" from being
  // reported as an outage, which would otherwise make every run look degraded.
  if (!deps.poolLookup) return null;
  rejections.attempted += 1;
  let match: PoolMatch | null;
  try {
    match = await deps.poolLookup(scene, deps.now);
  } catch {
    rejections.errored += 1;
    return null;
  }
  // The pool rung reports a zeroed match rather than null when it ran and found
  // nothing, so a rejected count is always available and never inferred.
  if (match?.rejected === "date" || match?.rejected === "duration") {
    rejections.duration += match.rejected === "duration" ? 1 : 0;
    rejections.date += match.rejectedByDate;
    rejections.unknownDate += match.unknownDate;
    rejections.noMatch += 1;
    return null;
  }
  if (!match || !match.url || dead.has(match.url)) {
    rejections.noMatch += 1;
    return null;
  }
  return { link: linkFor("eporner-pool", match.url, deps.now), tier: match.identityTier };
}

async function trySxyprn(
  scene: MatchScene,
  dead: Set<string>,
  deps: ResolveDeps,
  rejections: RungRejections,
): Promise<{ link: VideoLink; tier: IdentityTier } | null> {
  if (!deps.sxyprnLookup) return null;
  rejections.attempted += 1;
  let matches: SxyprnMatch[];
  try {
    matches = await deps.sxyprnLookup(scene);
  } catch {
    rejections.errored += 1;
    return null;
  }
  if (!matches.length) {
    rejections.noMatch += 1;
    return null;
  }
  const found = matches.find((candidate) => validSxyprnUrl(candidate.url) && !dead.has(candidate.url));
  if (!found) {
    rejections.noMatch += 1;
    return null;
  }
  return { link: linkFor("sxyprn", found.url, deps.now), tier: found.identityTier };
}

async function tryOpen(
  scene: MatchScene,
  dead: Set<string>,
  deps: ResolveDeps,
  rejections: RungRejections,
): Promise<{ link: VideoLink; tier: IdentityTier } | null> {
  if (!deps.openLookup) return null;
  rejections.attempted += 1;
  let matches: EpornerOpenMatch[];
  try {
    matches = await deps.openLookup(scene);
  } catch {
    rejections.errored += 1;
    return null;
  }
  for (const match of matches) {
    const id = epornerVideoId(match.video.url ?? "") ?? String(match.video.id ?? "");
    const url = id ? epornerWatchUrl(id) : "";
    if (url && !dead.has(url)) {
      return { link: linkFor("eporner", url, deps.now), tier: match.identityTier };
    }
  }
  rejections.noMatch += 1;
  return null;
}

/**
 * Resolve one scene. A scene with a live link is left alone (re-verify owns it);
 * a metadata-only lane and a duration-less scene are left untouched and retried
 * on a later pass.
 */
export async function resolveScene(
  scene: Scene,
  deps: ResolveDeps,
  rejections: RungRejections = emptyRejections(),
): Promise<ResolveResult> {
  if (deps.matcher === null) return { scene, changed: false, matched: false, rung: "none", tier: null };
  if (scene.videoUrls.length > 0) return { scene, changed: false, matched: false, rung: null, tier: null };
  if (!Number.isFinite(scene.durationSec) || (scene.durationSec ?? 0) <= 0) {
    return { scene, changed: false, matched: false, rung: null, tier: null };
  }

  const matchScene = buildMatchScene(scene, deps.creatorStudio);
  const dead = new Set(scene.deadVideoUrls.map((link) => link.url));

  const pool = await tryPool(matchScene, dead, deps, rejections);
  const winner =
    pool ??
    (await trySxyprn(matchScene, dead, deps, rejections)) ??
    (await tryOpen(matchScene, dead, deps, rejections));

  if (!winner) {
    return {
      scene: { ...scene, videoCheckedAt: deps.now.toISOString() },
      changed: true,
      matched: false,
      rung: null,
      tier: null,
    };
  }

  const { link, tier } = winner;
  const rung: Rung = link.source === "sxyprn" ? "sxyprn" : link.source === "eporner" ? "eporner-open" : "eporner-pool";
  const rule = rung === "eporner-pool" ? POOL_RULE : rung === "sxyprn" ? SXYPRN_RULE : OPEN_RULE;
  return {
    scene: {
      ...scene,
      videoUrls: [link],
      videoCheckedAt: deps.now.toISOString(),
      videoMatching: {
        lane: link.source,
        matchedAt: deps.now.toISOString(),
        rule,
        confidence: confidenceFor(tier),
      },
    },
    changed: true,
    matched: true,
    rung,
    tier,
  };
}

export interface ResolveLinksOptions {
  scenes: Scene[];
  now: Date;
  mapWithConcurrency: <T, R>(items: T[], task: (item: T, index: number) => Promise<R>) => Promise<R[]>;
  /** The declared lane per scene, so a metadata-only lane is skipped. */
  matcherFor: (scene: Scene) => { matcher: string | null; creatorStudio: boolean };
  poolLookup: ResolveDeps["poolLookup"];
  sxyprnLookup: ResolveDeps["sxyprnLookup"];
  openLookup: ResolveDeps["openLookup"];
  /** Optional cap on how many eligible scenes are resolved this cycle. */
  limit?: number;
}

/**
 * Resolve every eligible scene, preserving input order. Returns the updated
 * scenes and counts; the caller persists only the changed ones.
 *
 * Eligibility is deliberately NOT performer-gated. The old rule required a
 * performer to match at all, which meant a scene whose upstream data happens to
 * be missing its cast list could never be linked, however obviously its video
 * was. A performer-less scene is now eligible and simply ranks on fewer signals.
 */
export async function resolveLinks({
  scenes,
  now,
  mapWithConcurrency,
  matcherFor,
  poolLookup,
  sxyprnLookup,
  openLookup,
  limit,
}: ResolveLinksOptions): Promise<{
  scenes: Scene[];
  changed: Scene[];
  matched: number;
  considered: number;
  rejections: RungRejections;
  /** The identity tier of every winner this run, for the tier histogram. */
  tiers: IdentityTier[];
}> {
  const eligible = scenes.filter((scene) => {
    if (matcherFor(scene).matcher === null) return false;
    if (scene.videoUrls.length > 0) return false;
    return Number.isFinite(scene.durationSec) && (scene.durationSec ?? 0) > 0;
  });
  const queue = limit ? eligible.slice(0, limit) : eligible;
  const rejections = emptyRejections();
  // Shared and mutated in place: `mapWithConcurrency` interleaves scenes, and a
  // per-scene counter could not be summed without racing.
  const results = await mapWithConcurrency(queue, (scene) => {
    const { matcher, creatorStudio } = matcherFor(scene);
    return resolveScene(scene, { matcher, creatorStudio, now, poolLookup, sxyprnLookup, openLookup }, rejections);
  });
  const byId = new Map(results.map((result) => [result.scene.id, result.scene]));
  let matched = 0;
  const tiers: IdentityTier[] = [];
  const changed: Scene[] = [];
  for (const result of results) {
    if (result.matched && result.tier !== null) {
      matched += 1;
      tiers.push(result.tier);
    }
    if (result.changed) changed.push(result.scene);
  }
  return {
    scenes: scenes.map((scene) => byId.get(scene.id) ?? scene),
    changed,
    matched,
    considered: queue.length,
    rejections,
    tiers,
  };
}
