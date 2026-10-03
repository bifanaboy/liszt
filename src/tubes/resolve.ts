/**
 * Link resolution - the two-rung ladder, and the place a sparse identity signal
 * is managed rather than worked around.
 *
 * For each scene with no live link, a positive duration, and a non-`none`
 * matcher lane, in order:
 *
 *   1. eporner trusted pool   (rung 1, the hot path)
 *   2. sxyprn                 (search cards, verify details, then gate identity)
 *
 * A rung that finds nothing hands the scene to the next one. If both tubes
 * answer without an identity-backed match, the terminal fallback picks the
 * highest-view date-and-duration survivor across both and flags it `low`.
 * Errors are not clean no-matches: their candidate lists are empty, but the
 * other tube can still supply the fallback. The eporner
 * open-search rung that used to sit at position 3 is DELETED, and the reason is
 * not that it misbehaved but that it could not do its job: the eporner v2 search
 * API takes `query, per_page, page, thumbsize, order, gay, lq, format` and no
 * upload date, so reaching a release 90 days old means paginating backwards
 * from `order=latest` with no reliable stop. It also could not know whose video
 * it had found: the uploader appears only in the video page markup, never in
 * `video/search/` or `video/id/`, so an untrusted account was invisible to it
 * and every video that account uploaded inside the window went unlinked.
 *
 * The rule is the same on both rungs. Duration and upload window filter, then
 * performer-in-title GATES: a rung may only link a candidate it can name, and a
 * gated no-match moves to the next tube rather than guessing.
 *
 * A source that ERRORS is not a source that found nothing: an error lets the
 * next rung run, and the recorded outcome is a clean no-match only if a rung
 * actually answered. A scene that was never matched still has `videoCheckedAt`
 * stamped so the read model can say when it was last looked at.
 *
 * A named winner is `high` when its identity tier is 1, 2 or 3; tier 1 is a
 * first-name match and remains useful evidence. The terminal fallback is always
 * `low`, because views can rank survivors but cannot establish identity. Those
 * are the links worth checking by hand.
 *
 * The high-confidence safety rule is unchanged: a rung writes a high-confidence
 * URL only when it clears the shared identity gate. The explicit exception is
 * the terminal fallback: after all tubes have run, it picks the highest-view
 * date-and-duration survivor and marks it `low`, so the guess stays visible.
 * A URL already in `deadVideoUrls` is never re-added.
 */
import { validSxyprnUrl, type SxyprnMatch } from "./sxyprn.ts";
import { FC2_EPORNER_RULE, fc2ReleaseCode, type Fc2LookupResult } from "./fc2-eporner.ts";
import { validEpornerUrl } from "./eporner.ts";
import { toMatchScene, type MatchScene, type Rung } from "./types.ts";
import type { PoolMatch } from "./eporner-pool.ts";
import {
  identityTier,
  pickHighestViews,
  pickMatch,
  type IdentityTier,
  type TubeCandidate,
} from "../core/matching.ts";
import type { Scene, VideoLink, VideoLinkSource } from "../core/schema.ts";

const RULE_SHAPE =
  "duration within tolerance AND upload date within release-1d..release+window; identity gates, then ranks";

export const POOL_RULE = `trusted-pool: ${RULE_SHAPE}`;
export const SXYPRN_RULE = `sxyprn: ${RULE_SHAPE}; post details verified, not the search card`;
export const LOW_CONFIDENCE_RULE =
  "terminal fallback: highest view count among all date-and-duration survivors; no tube named the scene";

/** `low` is the decoy path: a winner with no identity evidence. */
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
  /**
   * Where a rung's own failure is reported, so a rung that is down is
   * distinguishable from a rung that found nothing. Optional so a caller without
   * a logger still gets the counters.
   */
  log?: { warn(message: string, fields?: Record<string, unknown>): void };
}

export interface ResolveResult {
  scene: Scene;
  changed: boolean;
  matched: boolean;
  rung: Rung | "fallback" | "fc2-eporner" | "none" | null;
  /** The winner's identity tier, or null when nothing matched. */
  tier: IdentityTier | null;
}

/**
 * One winner, as the run ledger records it.
 *
 * The tier alone cannot say whether the ladder considered a scene or merely
 * guessed at it. The terminal fallback reports whatever tier its survivor
 * happened to earn, so a tier-0 winner and a fallback are the same observation
 * from the tier's side, and `rung` is what separates a rung that NAMED the scene
 * from the guess the ladder makes when no tube can.
 */
export interface Winner {
  rung: Rung | "fallback" | "fc2-eporner";
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
  /**
   * Pool searches that stopped at the hydration cap, so their negative is not an
   * exhaustive one: candidates past the cut were never examined.
   *
   * These are counted apart from `noMatch` because a truncated search is not
   * proof the scene has no video, and the run ledger is the only place that
   * difference survives the cycle.
   */
  incomplete: number;
  /** Candidates rejected for falling outside the upload window. */
  date: number;
  /** Candidates rejected for having no readable upload date at all. */
  unknownDate: number;
  /** Scenes where the duration band left nothing. */
  duration: number;
}

export function emptyRejections(): RungRejections {
  return {
    attempted: 0,
    noMatch: 0,
    errored: 0,
    incomplete: 0,
    date: 0,
    unknownDate: 0,
    duration: 0,
  };
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

interface CandidateChoice {
  link: VideoLink;
  tier: IdentityTier;
}

interface FallbackCandidate {
  source: VideoLinkSource;
  candidate: TubeCandidate;
  tier: IdentityTier;
}

interface RungAttempt {
  winner: CandidateChoice | null;
  leftovers: FallbackCandidate[];
}

/** Create a lookup result with neither a winner nor candidates for the fallback. */
const emptyAttempt = (): RungAttempt => ({ winner: null, leftovers: [] });

/**
 * Try the trusted pool, update rejection counts, and retain fallback candidates if no winner
 * exists.
 */
async function tryPool(
  scene: MatchScene,
  dead: Set<string>,
  deps: ResolveDeps,
  rejections: RungRejections,
): Promise<RungAttempt> {
  // A rung that is not CONFIGURED is not a rung that errored. Returning here
  // before the counters matter keeps "this source is switched off" from being
  // reported as an outage, which would otherwise make every run look degraded.
  if (!deps.poolLookup) return emptyAttempt();
  rejections.attempted += 1;
  let match: PoolMatch | null;
  try {
    match = await deps.poolLookup(scene, deps.now);
  } catch (error) {
    rejections.errored += 1;
    logRungFailure(deps, "eporner-pool", error);
    return emptyAttempt();
  }
  const leftovers = (match?.fallbackCandidates ?? [])
    .filter((candidate) => candidate.url && !dead.has(candidate.url))
    .map((candidate) => ({
      source: "eporner-pool" as const,
      candidate,
      tier: identityTierFor(scene, candidate.title),
    }));
  // A capped search is counted wherever the rung lands, so `incomplete` reads as
  // the cap-hit frequency rather than only the runs that happened to come out
  // empty. It must NOT also count as `noMatch`: the candidates past the cut were
  // never examined, and reporting them as a clean negative is the claim this
  // counter exists to stop making.
  if (match?.hydrationCapped) rejections.incomplete += 1;
  // The pool rung reports a zeroed match rather than null when it ran and found
  // nothing, so a rejected count is always available and never inferred.
  if (match?.rejected === "incomplete") {
    // Return the survivors that DID clear the gate for the terminal fallback,
    // which is still a flagged guess rather than silence, but leave the rung's
    // own negative uncounted: the ladder has not exhausted its candidates.
    return { winner: null, leftovers };
  }
  if (match?.rejected === "date" || match?.rejected === "duration") {
    rejections.duration += match.rejected === "duration" ? 1 : 0;
    rejections.date += match.rejectedByDate;
    rejections.unknownDate += match.unknownDate;
    rejections.noMatch += 1;
    return { winner: null, leftovers };
  }
  if (match?.url && !dead.has(match.url) && match.identityTier > 0) {
    return {
      winner: {
        link: linkFor("eporner-pool", match.url, deps.now),
        tier: match.identityTier,
      },
      leftovers: [],
    };
  }
  if (!match || !match.url || dead.has(match.url) || match.identityTier === 0) {
    rejections.noMatch += 1;
    // Tests and injected callers may return an older-style winning row without
    // the survivor array. Retain that concrete row for the fallback instead of
    // silently losing the only evidence the rung returned.
    if (match?.url && !dead.has(match.url) && !leftovers.length) {
      leftovers.push({
        source: "eporner-pool",
        candidate: {
          url: match.url,
          title: match.title,
          views: null,
        },
        tier: match.identityTier,
      });
    }
    return { winner: null, leftovers };
  }
  return { winner: null, leftovers };
}

/** Compute a title's identity tier for the fallback candidate recorded in the run ledger. */
function identityTierFor(scene: MatchScene, title: string): IdentityTier {
  // Keep the fallback's tier accurate for the run ledger even though the final
  // confidence is forced low. The identity signal has already failed to produce
  // a high-confidence winner, and the fallback rule remains visibly distinct.
  return identityTier(scene, title);
}

/**
 * A rung that threw, named. Counted per rung, not across the ladder.
 *
 * One shared counter meant a rung that fails on every scene it touched and a
 * rung that fails on one were indistinguishable in the run log: `seenSoFar` ran
 * past 100 with no way to say which tube it belonged to. That is how the sxyprn
 * rung came to be described as "returns nothing in production" on the strength
 * of an aggregate - a blocked datacenter IP, an uninstalled optional package
 * and a genuine outage all looked identical from the outside. Throttled per
 * rung to its first failure and then every tenth, so a rung that is down for a
 * whole cycle cannot flood the log while the other rung's failures stay
 * countable on their own.
 */
const rungFailuresLogged = new Map<string, number>();

/** Log a rung's first failure and then every tenth, so a dead rung cannot flood the log. */
function logRungFailure(deps: Pick<ResolveDeps, "log">, rung: string, error: unknown): void {
  const seen = (rungFailuresLogged.get(rung) ?? 0) + 1;
  rungFailuresLogged.set(rung, seen);
  // The rung's first failure, then every tenth after it - so `seenSoFar` reads
  // 1, 11, 21 rather than 1, 10, 20, and one rung's outage cannot swallow the
  // other's log lines.
  if (seen !== 1 && seen % 10 !== 1) return;
  deps.log?.warn("ladder rung failed", {
    rung,
    error: (error as Error)?.message ?? String(error),
    seenSoFar: seen,
  });
}

/**
 * Try sxyprn for an identity match, counting rejections and retaining tier-zero fallback
 * candidates.
 */
async function trySxyprn(
  scene: MatchScene,
  dead: Set<string>,
  deps: ResolveDeps,
  rejections: RungRejections,
): Promise<RungAttempt> {
  if (!deps.sxyprnLookup) return emptyAttempt();
  rejections.attempted += 1;
  let matches: SxyprnMatch[];
  try {
    matches = await deps.sxyprnLookup(scene);
  } catch (error) {
    rejections.errored += 1;
    logRungFailure(deps, "sxyprn", error);
    return emptyAttempt();
  }
  const usable = matches.filter(
    (candidate) => validSxyprnUrl(candidate.url) && !dead.has(candidate.url),
  );
  const named = usable.filter((candidate) => candidate.identityTier > 0);
  if (named.length) {
    // Reuse the shared rank chain for named results: identity tier, views, lag,
    // URL. These candidates have already passed the rung's date and duration
    // filters, so the second pick widens only to their largest observed delta
    // and defers date; it cannot admit anything new, it only orders survivors.
    const maxDelta = Math.max(
      ...named.map((candidate) => Math.abs(candidate.duration - (scene.durationSec ?? 0))),
    );
    const best = pickMatch(scene, named, {
      durationToleranceSec: maxDelta,
      dateWindowDays: null,
      requireIdentity: true,
    });
    const found = named.find((candidate) => candidate.url === best?.candidate.url);
    if (found) {
      return {
        winner: {
          link: linkFor("sxyprn", found.url, deps.now),
          tier: found.identityTier,
        },
        leftovers: [],
      };
    }
  }
  const leftovers = usable
    .filter((candidate) => candidate.identityTier === 0)
    .map((candidate) => ({
      source: "sxyprn" as const,
      candidate,
      tier: candidate.identityTier,
    }));
  rejections.noMatch += 1;
  return { winner: null, leftovers };
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
  if (deps.matcher === null)
    return { scene, changed: false, matched: false, rung: "none", tier: null };
  if (scene.videoUrls.length > 0)
    return { scene, changed: false, matched: false, rung: null, tier: null };
  if (!Number.isFinite(scene.durationSec) || (scene.durationSec ?? 0) <= 0) {
    return { scene, changed: false, matched: false, rung: null, tier: null };
  }

  const matchScene = buildMatchScene(scene, deps.creatorStudio);
  const dead = new Set(scene.deadVideoUrls.map((link) => link.url));

  const pool = await tryPool(matchScene, dead, deps, rejections);
  const sxyprn = pool.winner ? emptyAttempt() : await trySxyprn(matchScene, dead, deps, rejections);
  let winner = pool.winner ?? sxyprn.winner;
  let usedFallback = false;

  if (!winner) {
    const leftovers = [...pool.leftovers, ...sxyprn.leftovers];
    const candidate = pickHighestViews(leftovers.map((entry) => entry.candidate));
    const fallback = leftovers.find((entry) => entry.candidate === candidate);
    if (candidate?.url && fallback) {
      winner = {
        link: linkFor(fallback.source, candidate.url, deps.now),
        tier: fallback.tier,
      };
      usedFallback = true;
    }
  }

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
  const rung: Rung | "fallback" = usedFallback
    ? "fallback"
    : link.source === "sxyprn"
      ? "sxyprn"
      : "eporner-pool";
  const rule = usedFallback
    ? LOW_CONFIDENCE_RULE
    : rung === "eporner-pool"
      ? POOL_RULE
      : SXYPRN_RULE;
  return {
    scene: {
      ...scene,
      videoUrls: [link],
      videoCheckedAt: deps.now.toISOString(),
      videoMatching: {
        lane: link.source,
        matchedAt: deps.now.toISOString(),
        rule,
        confidence: usedFallback ? "low" : confidenceFor(tier),
      },
    },
    changed: true,
    matched: true,
    rung,
    tier,
  };
}

/** The source id whose scenes are resolved by the FC2 lane instead of the ladder. */
export const FC2_LANE_SOURCE_ID = "fc2cmadb";

/**
 * Resolve one FC2 scene through the exact-release-code eporner lane.
 *
 * Every link the lane returns is stored, not just the first. That is the one
 * place in the app where a scene can carry several live links, and it is why the
 * result is high-confidence with no identity tier: the winner is not ranked at
 * all - every exact-code upload is kept, each re-verified on its own later, and
 * the only judgement applied is whether the uploads form a verified multipart
 * group.
 *
 * The lane's own `error` is counted and named rather than dropped. It reports
 * failures IN its result, so reading only `.links` turned an eporner outage into
 * an empty list and this resolver stamped `videoCheckedAt` exactly as it would
 * for a scene that genuinely has no upload - an invisible missed match, counted
 * as a clean negative in the run ledger. Links returned alongside an error are
 * still processed: a partial answer is an answer.
 */
export async function resolveFc2Scene(
  scene: Scene,
  deps: {
    now: Date;
    lookup: (code: string) => Promise<Fc2LookupResult>;
    log?: ResolveDeps["log"];
  },
  rejections: RungRejections = emptyRejections(),
): Promise<ResolveResult> {
  const code = fc2ReleaseCode(scene.releaseUrl) ?? fc2ReleaseCode(scene.id.split(":").pop() ?? "");
  const stamp = { videoCheckedAt: deps.now.toISOString() };
  if (!code)
    return { scene: { ...scene, ...stamp }, changed: true, matched: false, rung: null, tier: null };
  const dead = new Set(scene.deadVideoUrls.map((link) => link.url));
  let looked: Fc2LookupResult;
  try {
    looked = await deps.lookup(code);
  } catch (error) {
    // The lane reports failures in its result, so a throw here is the unexpected
    // shape. It is still an outage rather than a clean no-match.
    rejections.errored += 1;
    logRungFailure(deps, "fc2-eporner", error);
    // A lane that cannot read its evidence produces NO link rather than a
    // guessed one. The scene is still stamped as checked so the next cycle
    // reconsiders it rather than treating it as resolved.
    return { scene: { ...scene, ...stamp }, changed: true, matched: false, rung: null, tier: null };
  }
  if (looked.error) {
    rejections.errored += 1;
    logRungFailure(deps, "fc2-eporner", looked.error);
  }
  const live = looked.links.filter((link) => validEpornerUrl(link.url) && !dead.has(link.url));
  if (!live.length) {
    return { scene: { ...scene, ...stamp }, changed: true, matched: false, rung: null, tier: null };
  }
  return {
    scene: {
      ...scene,
      videoUrls: live.map((link) => ({
        source: "eporner" as const,
        url: link.url,
        verifiedAt: deps.now.toISOString(),
        verifyFailures: 0,
        ...(link.part === undefined ? {} : { part: link.part }),
      })),
      ...stamp,
      videoMatching: {
        lane: "fc2-eporner",
        matchedAt: deps.now.toISOString(),
        rule: FC2_EPORNER_RULE,
        confidence: "high" as const,
      },
    },
    changed: true,
    matched: true,
    rung: "fc2-eporner",
    tier: null,
  };
}

export interface ResolveLinksOptions {
  scenes: Scene[];
  now: Date;
  mapWithConcurrency: <T, R>(
    items: T[],
    task: (item: T, index: number) => Promise<R>,
  ) => Promise<R[]>;
  /** The declared lane per scene, so a metadata-only lane is skipped. */
  matcherFor: (scene: Scene) => { matcher: string | null; creatorStudio: boolean };
  poolLookup: ResolveDeps["poolLookup"];
  sxyprnLookup: ResolveDeps["sxyprnLookup"];
  /**
   * The FC2 lane's own resolver, applied INSTEAD of the ladder to scenes of
   * `fc2SourceId`. Null leaves every scene on the shared ladder.
   *
   * This is a lane SWITCH rather than a third rung, and the difference is not
   * cosmetic: the ladder may only link a candidate it can name, and an FC2
   * release is named by a numeric code in a repost title rather than by a
   * performer in either title. Adding that as a rung would mean widening the
   * shared gates for every lane; keeping it here means the ladder's date,
   * duration, performer and rung behaviour is untouched for every other lane.
   */
  fc2Lookup?: ((code: string) => Promise<Fc2LookupResult>) | null;
  /** The source id whose scenes leave the ladder. Defaults to the FC2 lane. */
  fc2SourceId?: string;
  log?: ResolveDeps["log"];
  /** Optional cap on how many eligible scenes are resolved this cycle. */
  limit?: number;
  /**
   * Progress of the resolve queue, for the dashboard's live meter.
   *
   * Called once with `done: 0` and the queue length, then once per COMPLETED
   * scene. `mapWithConcurrency` interleaves the tasks, so `done` is a completion
   * count supplied by the caller and must never be derived from a result index -
   * that would make the bar jump backwards.
   */
  onProgress?: (done: number, total: number, matched: number) => void;
}

/**
 * Resolve every eligible scene, preserving input order. Returns the updated
 * scenes and counts; the caller persists only the changed ones.
 *
 * Eligibility is deliberately NOT performer-gated. The old rule required a
 * performer to match at all, which meant a scene whose upstream data happens to
 * be missing its cast list could never be linked, however obviously its video
 * was. A performer-less scene is still eligible here - it is the RUNGS that
 * require identity, not the queue - and if no tube can name it the terminal
 * fallback may still provide a clearly flagged low-confidence link.
 */
export async function resolveLinks({
  scenes,
  now,
  mapWithConcurrency,
  matcherFor,
  poolLookup,
  sxyprnLookup,
  fc2Lookup = null,
  fc2SourceId = FC2_LANE_SOURCE_ID,
  log,
  limit,
  onProgress,
}: ResolveLinksOptions): Promise<{
  scenes: Scene[];
  changed: Scene[];
  matched: number;
  considered: number;
  rejections: RungRejections;
  /** Which rung produced each winner, with its tier, for the run's own tally. */
  winners: Winner[];
}> {
  const eligible = scenes.filter((scene) => {
    if (matcherFor(scene).matcher === null) return false;
    if (scene.videoUrls.length > 0) return false;
    return Number.isFinite(scene.durationSec) && (scene.durationSec ?? 0) > 0;
  });
  // `limit ? ... : ...` treated a limit of `0` as "no limit", which is the
  // opposite of what a caller passing 0 means, and passed a negative value
  // straight to `slice`, which counts from the end - so `-5` resolved the LAST
  // five scenes instead of none. `undefined` is the only "unbounded" value.
  const bounded = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
  const queue = bounded === undefined ? eligible : eligible.slice(0, bounded);
  const rejections = emptyRejections();
  // Shared and mutated in place: `mapWithConcurrency` interleaves scenes, and a
  // per-scene counter could not be summed without racing. `matched` is the same
  // shape for the same reason - the progress callback is handed a running total
  // from inside the concurrent region, exactly like `rejections` is.
  let matched = 0;
  let done = 0;
  onProgress?.(0, queue.length, 0);
  // The FC2 queue is taken OUT of the ladder's queue before the fan-out rather
  // than branched inside it. A rung that runs `tryPool` first and then ignores
  // its result would still spend the trusted pool's hydration requests on every
  // FC2 scene, which is the expensive part.
  const fc2Queue = fc2Lookup ? queue.filter((scene) => scene.sourceId === fc2SourceId) : [];
  const ladderQueue = fc2Lookup ? queue.filter((scene) => scene.sourceId !== fc2SourceId) : queue;
  const ladder = await mapWithConcurrency(ladderQueue, async (scene) => {
    const { matcher, creatorStudio } = matcherFor(scene);
    const result = await resolveScene(
      scene,
      { matcher, creatorStudio, now, poolLookup, sxyprnLookup, log },
      rejections,
    );
    if (result.matched && result.tier !== null) matched += 1;
    done += 1;
    onProgress?.(done, queue.length, matched);
    return result;
  });
  // The FC2 lane is resolved through the same bounded fan-out. Its own resolver
  // paces its requests internally and serialises them behind that gate, so the
  // fan-out's concurrency costs nothing extra here.
  const fc2Results = await mapWithConcurrency(fc2Queue, async (scene) => {
    const result = await resolveFc2Scene(
      scene,
      {
        now,
        lookup: fc2Lookup as NonNullable<ResolveLinksOptions["fc2Lookup"]>,
        ...(log ? { log } : {}),
      },
      rejections,
    );
    if (result.matched) matched += 1;
    done += 1;
    onProgress?.(done, queue.length, matched);
    return result;
  });
  const results = [...ladder, ...fc2Results];
  const byId = new Map(results.map((result) => [result.scene.id, result.scene]));
  const winners: Winner[] = [];
  const changed: Scene[] = [];
  for (const result of results) {
    // A matched scene always carries a rung: `"none"` is the metadata-only lane,
    // which cannot have matched. Keeping the rung beside the tier is what lets the
    // run row state a named match and a guess apart. The FC2 lane has tier `null`
    // but its rung is `fc2-eporner`, not `none`.
    if (result.matched && result.rung && result.rung !== "none") {
      winners.push({ rung: result.rung, tier: result.tier });
    }
    if (result.changed) changed.push(result.scene);
  }
  return {
    scenes: scenes.map((scene) => byId.get(scene.id) ?? scene),
    changed,
    matched,
    considered: queue.length,
    rejections,
    winners,
  };
}
