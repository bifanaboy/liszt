import { validSxyprnUrl } from "./sxyprn.js";
import { FC2_EPORNER_RULE, fc2ReleaseCode } from "./fc2-eporner.js";
import { validEpornerUrl } from "./eporner.js";
import { toMatchScene } from "./types.js";
import { identityTier, pickHighestViews, pickMatch } from "../matching.js";
const RULE_SHAPE =
  "duration within tolerance AND upload date within release-1d..release+window; identity gates, then ranks";
export const POOL_RULE = `trusted-pool: ${RULE_SHAPE}`;
export const SXYPRN_RULE = `sxyprn: ${RULE_SHAPE}; post details verified, not the search card`;
export const LOW_CONFIDENCE_RULE =
  "terminal fallback: highest view count among all date-and-duration survivors; no tube named the scene";
function confidenceFor(tier) {
  return tier === 0 || tier === undefined ? "low" : "high";
}
export function emptyRejections() {
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
export function buildMatchScene(scene, creatorStudio) {
  const base = toMatchScene(scene);
  if (creatorStudio) base.creatorStudio = true;
  return base;
}
function linkFor(source, url, now) {
  return { source, url, verifiedAt: now.toISOString(), verifyFailures: 0 };
}
const emptyAttempt = () => ({ winner: null, leftovers: [] });
async function tryPool(scene, dead, deps, rejections) {
  if (!deps.poolLookup) return emptyAttempt();
  rejections.attempted += 1;
  let result;
  try {
    result = await deps.poolLookup(scene, deps.now);
  } catch (error) {
    rejections.errored += 1;
    logRungFailure(deps, "eporner-pool", error);
    return emptyAttempt();
  }
  const leftovers = (result?.fallbackCandidates ?? [])
    .filter((candidate) => candidate.url && !dead.has(candidate.url))
    .map((candidate) => ({
      source: "eporner-pool",
      candidate,
      tier: identityTierFor(scene, candidate.title),
    }));
  if (result?.hydrationCapped) rejections.incomplete += 1;
  if (result?.rejected === "incomplete") {
    return { winner: null, leftovers };
  }
  if (result?.rejected === "date" || result?.rejected === "duration") {
    rejections.duration += result.rejected === "duration" ? 1 : 0;
    rejections.date += result.rejectedByDate;
    rejections.unknownDate += result.unknownDate;
    rejections.noMatch += 1;
    return { winner: null, leftovers };
  }
  if (result?.url && !dead.has(result.url) && result.identityTier > 0) {
    return {
      winner: {
        link: linkFor("eporner-pool", result.url, deps.now),
        tier: result.identityTier,
      },
      leftovers: [],
    };
  }
  if (!result || !result.url || dead.has(result.url) || result.identityTier === 0) {
    rejections.noMatch += 1;
    if (result?.url && !dead.has(result.url) && !leftovers.length) {
      leftovers.push({
        source: "eporner-pool",
        candidate: {
          url: result.url,
          title: result.title,
          views: null,
        },
        tier: result.identityTier,
      });
    }
    return { winner: null, leftovers };
  }
  return { winner: null, leftovers };
}
function identityTierFor(scene, title) {
  return identityTier(scene, title);
}
const rungFailuresLogged = new Map();
function logRungFailure(deps, rung, error) {
  const seen = (rungFailuresLogged.get(rung) ?? 0) + 1;
  rungFailuresLogged.set(rung, seen);
  if (seen !== 1 && seen % 10 !== 1) return;
  deps.log?.warn("ladder rung failed", {
    rung,
    error: error?.message ?? String(error),
    seenSoFar: seen,
  });
}
async function trySxyprn(scene, dead, deps, rejections) {
  if (!deps.sxyprnLookup) return emptyAttempt();
  rejections.attempted += 1;
  let matches;
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
    const maxDelta = Math.max(
      ...named.map((candidate) =>
        scene.durationRange
          ? Math.max(
              scene.durationRange.minSec - candidate.duration,
              0,
              candidate.duration - scene.durationRange.maxSec,
            )
          : Math.abs(candidate.duration - (scene.durationSec ?? 0)),
      ),
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
      source: "sxyprn",
      candidate,
      tier: candidate.identityTier,
    }));
  rejections.noMatch += 1;
  return { winner: null, leftovers };
}
export async function resolveScene(scene, deps, rejections = emptyRejections()) {
  if (deps.matcher === null)
    return { scene, changed: false, matched: false, rung: "none", tier: null };
  if (scene.videoUrls.length > 0)
    return { scene, changed: false, matched: false, rung: null, tier: null };
  if (
    scene.durationReview ||
    ((!Number.isFinite(scene.durationSec) || (scene.durationSec ?? 0) <= 0) && !scene.durationRange)
  ) {
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
  const rung = usedFallback ? "fallback" : link.source === "sxyprn" ? "sxyprn" : "eporner-pool";
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
export const FC2_LANE_SOURCE_ID = "fc2cmadb";
export async function resolveFc2Scene(scene, deps, rejections = emptyRejections()) {
  const code = fc2ReleaseCode(scene.releaseUrl) ?? fc2ReleaseCode(scene.id.split(":").pop() ?? "");
  const stamp = { videoCheckedAt: deps.now.toISOString() };
  if (!code)
    return { scene: { ...scene, ...stamp }, changed: true, matched: false, rung: null, tier: null };
  const dead = new Set(scene.deadVideoUrls.map((link) => link.url));
  let looked;
  try {
    looked = await deps.lookup(code);
  } catch (error) {
    rejections.errored += 1;
    logRungFailure(deps, "fc2-eporner", error);
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
        source: "eporner",
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
        confidence: "high",
      },
    },
    changed: true,
    matched: true,
    rung: "fc2-eporner",
    tier: null,
  };
}
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
}) {
  const eligible = scenes.filter((scene) => {
    if (matcherFor(scene).matcher === null) return false;
    if (scene.videoUrls.length > 0) return false;
    return (
      !scene.durationReview &&
      ((Number.isFinite(scene.durationSec) && (scene.durationSec ?? 0) > 0) ||
        Boolean(scene.durationRange))
    );
  });
  const bounded = limit === undefined ? undefined : Math.max(0, Math.floor(limit));
  const queue = bounded === undefined ? eligible : eligible.slice(0, bounded);
  const rejections = emptyRejections();
  let matched = 0;
  let done = 0;
  onProgress?.(0, queue.length, 0);
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
  const fc2Results = await mapWithConcurrency(fc2Queue, async (scene) => {
    const result = await resolveFc2Scene(
      scene,
      {
        now,
        lookup: fc2Lookup,
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
  const winners = [];
  const changed = [];
  for (const result of results) {
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
