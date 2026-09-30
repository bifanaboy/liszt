/**
 * `npm run calibrate` - the gate measurement harness.
 *
 * The upload window is a config knob, not a constant, and a knob nobody has
 * measured is a guess. This CLI produces the measurement instead:
 *
 *   1. Build the trusted-pool index from the live profile listings.
 *   2. Fetch the traxxx-lane scenes (the only lanes with measured pool
 *      coverage) and run the pool rung over each.
 *   3. Report four things, all of which the window's value should be read
 *      against:
 *        - a LAG HISTOGRAM, computed over every duration-surviving candidate
 *        - a per-stage FUNNEL: considered -> duration-passed -> date-passed
 *          -> linked
 *        - UNKNOWN-DATE counts, which is how a rung that cannot supply dates
 *          announces itself
 *        - the IDENTITY-TIER HISTOGRAM of the winners, where a rising tier-0
 *          share is the decoy signal
 *      plus the DURATION-DELTA DISTRIBUTION, which is the measurement that
 *      chooses the duration tolerance. See "The delta measurement is gathered
 *      wide" below.
 *   4. Print accepted link samples to eyeball by hand before trusting them.
 *
 * WHY THE HISTOGRAM IS NOT COMPUTED FROM THE WINNERS. A histogram of the links
 * you already accepted cannot show the tail the window exists to cut off, so it
 * would quietly justify whatever value the window already has. It is computed
 * from the full duration-surviving set instead, which is the set the window
 * actually gets to choose from.
 *
 * THE DELTA MEASUREMENT IS GATHERED WIDE. Every scan here runs at a SCAN
 * tolerance (`--delta-scan`, default 10s) far wider than the operational one,
 * so the histogram can show where true matches actually sit instead of being
 * truncated at the tolerance it is meant to judge. That is circular otherwise:
 * a +-1s scan can only ever report that true matches sit within 1s.
 *
 * GROUND TRUTH IS IDENTITY-ANCHORED, NOT CIRCULAR. A "true" match needs a label
 * nobody in this repo can supply by running the matcher, so it is APPROXIMATED
 * two ways, both recorded as such in the output:
 *
 *  - the PAIR histogram counts every (scene, candidate) whose title names the
 *    performer or reuses the studio's own title - `identityTier >= 1`, decided
 *    from TEXT alone, with the duration tolerance never consulted;
 *  - the PER-SCENE histogram is the tighter of the two readings and the one the
 *    tolerance should be chosen on: for each scene, the SMALLEST delta among
 *    its identity-anchored candidates. That is the drift a scene would suffer
 *    if the tolerance were set below it.
 *
 * Neither is human confirmation. The tier-1-or-better anchor is strong evidence
 * rather than proof, and the residue is stated by
 * `identityCoverage.scenesWithoutAnchoredCandidate`, which is the count of
 * scenes no text signal could name at all.
 *
 * The JSON report goes to stdout; logs go to stderr.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { HttpFetcher } from "../core/fetcher.ts";
import { JsonLogger } from "../core/logger.ts";
import { SqliteStore } from "../core/store/sqlite.ts";
import { mapIsolated, mapWithConcurrency } from "../core/concurrency.ts";
import {
  identityTier,
  pickMatch,
  withinDateWindow,
  type IdentityTier,
  type TubeCandidate,
} from "../core/matching.ts";
import { createSources } from "../sources/registry.ts";
import { gatherPoolSurvivors, indexPool, type PoolSurvivors } from "../tubes/eporner-pool.ts";
import { normaliseScene, dateOnly } from "../pipeline/sync.ts";
import { buildMatchScene } from "../tubes/resolve.ts";
import type { MatchScene, Rung } from "../tubes/types.ts";
import type { Scene } from "../core/schema.ts";

/** The traxxx lanes: the only lanes with measured trusted-pool coverage. */
const TRAXXX_LANE_IDS = new Set(["lancelot-styles-evolution", "mambo-perv", "tushy"]);

const DAY_MS = 86_400_000;

/**
 * The default SCAN tolerance for the delta measurement: ten seconds, and
 * deliberately not the operational value. See "THE DELTA MEASUREMENT IS GATHERED
 * WIDE" in the module note.
 */
const DEFAULT_DELTA_SCAN_SEC = 10;

/** The tolerances the report answers "what would this cost?" for. */
const TOLERANCE_PROBE_SEC = [0, 1, 2, 3, 5];

/** One scene, its full survivor set, and what the gate would have done with it. */
interface CalibrationEntry {
  scene: MatchScene;
  gathered: PoolSurvivors;
  winner: {
    url: string;
    uploader: string;
    title: string;
    identityTier: IdentityTier;
    lagDays: number | null;
    durationDeltaSec: number | null;
  } | null;
  dateRejected: number;
  unknownDate: number;
  /** Deltas of every in-window candidate whose title names the scene. */
  anchoredDeltas: number[];
  /** Deltas of every in-window candidate, named or not. */
  allDeltas: number[];
}

interface Sample {
  sceneId: string;
  sceneTitle: string;
  releaseDate: string;
  durationSec: number | null;
  rung: Rung;
  url: string;
  uploader: string;
  title: string;
  identityTier: IdentityTier;
  lagDays: number | null;
  durationDeltaSec: number | null;
  candidatesConsidered: number;
  durationPassed: number;
  hydrated: number;
  rejectedByDate: number;
  unknownDate: number;
}

/** Which bucket of the lag axis a candidate falls into. */
type LagBucket =
  | "unknown"
  | "before-window"
  | "lag-1d"
  | "lag-0d"
  | "lag-1-2d"
  | "lag-3-5d"
  | "lag-6-7d"
  | "lag-8-14d"
  | "lag-15d+";

/**
 * Which part of the lag axis a candidate falls into. The buckets are fixed
 * rather than derived from `windowDays` so two runs at different window values
 * are directly comparable - the point of the histogram is to see the tail the
 * window is cutting off, which a rescaled axis would hide.
 */
function bucketFor(lagDays: number | null): LagBucket {
  if (lagDays === null) return "unknown";
  if (lagDays < -1) return "before-window";
  if (lagDays <= 0) return lagDays === -1 ? "lag-1d" : "lag-0d";
  if (lagDays <= 2) return "lag-1-2d";
  if (lagDays <= 5) return "lag-3-5d";
  if (lagDays <= 7) return "lag-6-7d";
  if (lagDays <= 14) return "lag-8-14d";
  return "lag-15d+";
}

const BUCKET_ORDER: LagBucket[] = [
  "lag-0d",
  "lag-1d",
  "lag-1-2d",
  "lag-3-5d",
  "lag-6-7d",
  "lag-8-14d",
  "lag-15d+",
  "before-window",
  "unknown",
];

function emptyLagHistogram(): Record<LagBucket, number> {
  return Object.fromEntries(BUCKET_ORDER.map((bucket) => [bucket, 0])) as Record<LagBucket, number>;
}

function emptyTierHistogram(): Record<"0" | "1" | "2" | "3", number> {
  return { "0": 0, "1": 0, "2": 0, "3": 0 };
}

/** One second per bucket, then a catch-all for drift too large to bucket. */
const DELTA_BUCKETS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10+"] as const;
type DeltaBucket = (typeof DELTA_BUCKETS)[number];

/** Group a duration difference into rounded seconds up to nine, or the overflow bucket. */
function deltaBucket(delta: number): DeltaBucket {
  if (delta <= 0) return "0";
  if (delta <= 9) return String(Math.min(9, Math.round(delta))) as DeltaBucket;
  return "10+";
}

/** Create a duration-difference histogram with every bucket initialized to zero. */
function emptyDeltaHistogram(): Record<DeltaBucket, number> {
  return Object.fromEntries(DELTA_BUCKETS.map((bucket) => [bucket, 0])) as Record<
    DeltaBucket,
    number
  >;
}

/** Days from the release date to an upload date; null if either is unreadable. */
function lagDays(releaseDate: string, added: string | null): number | null {
  const release = Date.parse(releaseDate);
  const uploaded = Date.parse(added ?? "");
  if (!Number.isFinite(release) || !Number.isFinite(uploaded)) return null;
  return Math.round((uploaded - release) / DAY_MS);
}

/** Absolute candidate-versus-scene duration difference, or null if unreadable. */
function candidateDelta(scene: MatchScene, candidate: TubeCandidate): number | null {
  const duration = Number(candidate.duration);
  if (!Number.isFinite(duration)) return null;
  if (!Number.isFinite(scene.durationSec)) return null;
  return Math.abs(duration - (scene.durationSec ?? 0));
}

/** Index rows within `tolerance` of the scene's own duration. */
function rowsWithinBand(survivorDurations: number[], scene: MatchScene, tolerance: number): number {
  const target = scene.durationSec ?? 0;
  return survivorDurations.filter((duration) => Math.abs(duration - target) <= tolerance).length;
}

/** Parse calibration options, gather pool candidates, and print a JSON matching report. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string", default: "50" },
      tolerance: { type: "string" },
      window: { type: "string" },
      samples: { type: "string", default: "10" },
      "no-index": { type: "boolean", default: false },
      "delta-scan": { type: "string" },
    },
    allowPositionals: false,
  });

  const config = loadConfig();
  const log = new JsonLogger({ component: "calibrate" }, (line) =>
    process.stderr.write(`${line}\n`),
  );
  const store = new SqliteStore(config.dbPath);
  store.migrate();
  const fetcher = new HttpFetcher(config.fetchTimeoutMs);
  const now = new Date();
  const limit = Math.max(1, Number(values.limit) || 50);
  const tolerance = values.tolerance ? Number(values.tolerance) : config.matchDurationToleranceSec;
  const windowDays = values.window ? Number(values.window) : config.matchDateWindowDays;
  // The SCAN tolerance is separate from the operational one, and is never
  // narrowed to it: see "THE DELTA MEASUREMENT IS GATHERED WIDE" above. A scan
  // narrower than the operational tolerance would also understate the band, so
  // it is floored at the operational value rather than trusted to replace it.
  const scanRaw = values["delta-scan"] ? Number(values["delta-scan"]) : DEFAULT_DELTA_SCAN_SEC;
  const scanTolerance = Number.isFinite(scanRaw) ? Math.max(scanRaw, tolerance) : tolerance;
  const sampleCount = Math.max(0, Number(values.samples) || 0);

  try {
    let indexReport = { totalIndexed: 0, totalUndated: 0, uploaders: [] as unknown[], ok: true };
    if (!values["no-index"]) {
      indexReport = await indexPool({
        store,
        fetcher,
        now,
        uploaders: config.trustedUploaders,
        windowDays: config.windowDays,
        fullRewalkDays: config.poolFullRewalkDays,
        log: (message, fields) => log.info(message, fields),
      });
    }

    const sources = createSources({
      madouquApiBase: config.madouquApiBase,
      ...(config.maximoListingUrl ? { maximoListingUrl: config.maximoListingUrl } : {}),
    }).filter((adapter) => TRAXXX_LANE_IDS.has(adapter.id));
    const windowStart = dateOnly(new Date(now.getTime() - config.windowDays * DAY_MS));

    const matchScenes: MatchScene[] = [];
    for (const adapter of sources) {
      try {
        const result = await adapter.fetch(windowStart, {
          fetcher,
          now,
          log: (message, fields) => log.debug(message, { source: adapter.id, ...fields }),
          mapWithConcurrency: (items, task) =>
            mapWithConcurrency(items, task, config.fetchConcurrency),
          mapIsolated: (items, task) => mapIsolated(items, task, config.fetchConcurrency),
        });
        for (const raw of result.scenes) {
          const scene: Scene = normaliseScene(adapter, raw, now);
          matchScenes.push(buildMatchScene(scene, adapter.creatorStudio ?? false));
        }
      } catch (error) {
        log.warn("calibrate: a traxxx lane failed", {
          source: adapter.id,
          error: (error as Error).message,
        });
      }
    }

    // A performer-less scene is still eligible for date+duration survivor
    // measurement and for the terminal fallback, even though no candidate can
    // clear the identity gate. Filtering it out here would hide both the
    // low-confidence coverage and the scenes with no possible named match.
    const eligible = matchScenes.filter(
      (scene) => Number.isFinite(scene.durationSec) && (scene.durationSec ?? 0) > 0,
    );
    const sample = eligible.slice(0, limit);

    const results = await mapWithConcurrency(
      sample,
      async (scene): Promise<CalibrationEntry> => {
        const gathered = await gatherPoolSurvivors(
          scene,
          {
            store,
            fetcher,
            uploaders: config.trustedUploaders,
            durationToleranceSec: scanTolerance,
            dateWindowDays: windowDays,
            log: (message, fields) => log.debug(message, fields),
          },
          now,
        );
        // The same call the rung makes, so the winner the histogram counts is
        // the winner the ladder would have written. `pickMatch` re-applies the
        // duration band itself, so gathering wide does not leak a wider band
        // into the pick.
        const checks = gathered.candidates.map((candidate) =>
          withinDateWindow(scene.releaseDate, candidate.added, windowDays),
        );
        const inWindow = gathered.candidates.filter((_, index) => checks[index] === true);
        const picked = pickMatch(scene, inWindow, {
          durationToleranceSec: tolerance,
          dateWindowDays: windowDays,
          requireIdentity: true,
        });
        // The delta set is collected from the DATE-filtered candidates only. An
        // upload outside the window is not a near-miss at this duration, it is a
        // different video, and counting it would inflate the tail.
        const allDeltas: number[] = [];
        const anchoredDeltas: number[] = [];
        for (const candidate of inWindow) {
          const delta = candidateDelta(scene, candidate);
          if (delta === null) continue;
          allDeltas.push(delta);
          // Identity from text alone - the duration tolerance is not consulted,
          // which is what keeps this from being circular.
          if (identityTier(scene, candidate.title) >= 1) anchoredDeltas.push(delta);
        }
        return {
          scene,
          gathered,
          winner: picked
            ? {
                url: picked.candidate.url ?? "",
                uploader: String(picked.candidate.uploader ?? ""),
                title: picked.candidate.title,
                identityTier: picked.identityTier,
                lagDays: lagDays(scene.releaseDate, picked.candidate.added ?? null),
                durationDeltaSec: candidateDelta(scene, picked.candidate),
              }
            : null,
          dateRejected: checks.filter((check) => check === false).length,
          unknownDate: checks.filter((check) => check === "unknown").length,
          anchoredDeltas,
          allDeltas,
        };
      },
      config.fetchConcurrency,
    );

    // The lag histogram, over EVERY duration-surviving candidate. See the module
    // note: computing it from the winners would make it self-confirming.
    const lagHistogram = emptyLagHistogram();
    let hydrationCapped = 0;
    for (const entry of results) {
      if (entry.gathered.capped) hydrationCapped += 1;
      for (const candidate of entry.gathered.candidates) {
        const bucket = bucketFor(lagDays(entry.scene.releaseDate, candidate.added ?? null));
        lagHistogram[bucket] += 1;
      }
    }

    const matched = results.filter((entry) => entry.winner !== null);
    const tierHistogram = emptyTierHistogram();
    for (const entry of matched) {
      const tier = entry.winner!.identityTier;
      tierHistogram[String(tier) as "0" | "1" | "2" | "3"] += 1;
    }

    // The delta measurement. Two histograms over the same in-window candidate
    // sets - every candidate, and only those whose TITLE names the scene - plus
    // the per-scene minimum of the latter, which is the reading the tolerance
    // should be chosen on. See the module note for why "names the scene" is
    // chosen as the anchor: it is decided from text, never from duration.
    const deltaAll = emptyDeltaHistogram();
    const deltaAnchored = emptyDeltaHistogram();
    const perSceneMinDelta = emptyDeltaHistogram();
    let scenesWithAnchoredCandidate = 0;
    let anchoredPairCount = 0;
    for (const entry of results) {
      for (const delta of entry.allDeltas) deltaAll[deltaBucket(delta)] += 1;
      for (const delta of entry.anchoredDeltas) deltaAnchored[deltaBucket(delta)] += 1;
      anchoredPairCount += entry.anchoredDeltas.length;
      if (!entry.anchoredDeltas.length) continue;
      scenesWithAnchoredCandidate += 1;
      perSceneMinDelta[deltaBucket(Math.min(...entry.anchoredDeltas))] += 1;
    }

    /** Pairs and scenes that a candidate tolerance would keep. */
    const survives = (deltas: number[], toleranceSec: number): number =>
      deltas.filter((delta) => delta <= toleranceSec).length;
    const minDeltaByScene = results
      .map((entry) => (entry.anchoredDeltas.length ? Math.min(...entry.anchoredDeltas) : null))
      .filter((delta): delta is number => delta !== null);

    const toleranceCost = Object.fromEntries(
      TOLERANCE_PROBE_SEC.map((probe) => [
        `${probe}s`,
        {
          anchoredPairs: survives(
            results.flatMap((entry) => entry.anchoredDeltas),
            probe,
          ),
          scenesKept: survives(minDeltaByScene, probe),
          scenesLost: minDeltaByScene.length - survives(minDeltaByScene, probe),
        },
      ]),
    );

    // Band occupancy: how many index rows compete at each candidate tolerance,
    // summed over the scanned scenes. This is the DECOY side of the trade - the
    // cost of a tighter tolerance is not measured in lost links but in rows that
    // no longer get to compete, and it is the number that says whether a tighter
    // band is worth what the delta histogram says it costs.
    const bandOccupancy = Object.fromEntries(
      TOLERANCE_PROBE_SEC.map((probe) => [
        `${probe}s`,
        results.reduce(
          (total, entry) =>
            total + rowsWithinBand(entry.gathered.survivorDurations, entry.scene, probe),
          0,
        ),
      ]),
    );

    const durationDelta = {
      scanToleranceSec: scanTolerance,
      anchoredTier: "identityTier >= 1, decided from title text only",
      note: "Neither histogram is human confirmation of a match; they are text-anchored proxies.",
      allCandidates: deltaAll,
      anchoredCandidates: deltaAnchored,
      perSceneMinAnchoredDelta: perSceneMinDelta,
      toleranceCost,
      bandOccupancy,
      identityCoverage: {
        scenesWithAnchoredCandidate,
        scenesWithoutAnchoredCandidate: results.length - scenesWithAnchoredCandidate,
        anchoredPairs: anchoredPairCount,
      },
      hydrationCappedScenes: results.filter((entry) => entry.gathered.capped).length,
    };

    const funnel = {
      scenesConsidered: sample.length,
      indexRowsExamined: results.reduce((total, entry) => total + entry.gathered.considered, 0),
      // Counted at the OPERATIONAL tolerance, not the scan tolerance the gather
      // ran with. Reporting the scan figure here would overstate the band by
      // whatever the wide scan admitted, which is the number being measured and
      // not the number shipping.
      durationPassed: results.reduce(
        (total, entry) =>
          total + rowsWithinBand(entry.gathered.survivorDurations, entry.scene, tolerance),
        0,
      ),
      scanDurationPassed: results.reduce(
        (total, entry) => total + entry.gathered.survivorDurations.length,
        0,
      ),
      datePassed: results.reduce(
        (total, entry) =>
          total +
          entry.gathered.candidates.filter(
            (candidate) =>
              withinDateWindow(entry.scene.releaseDate, candidate.added, windowDays) === true,
          ).length,
        0,
      ),
      linked: matched.length,
    };

    const accepted: Sample[] = matched.slice(0, sampleCount).map((entry) => ({
      sceneId: entry.scene.id,
      sceneTitle: entry.scene.title,
      releaseDate: entry.scene.releaseDate,
      durationSec: entry.scene.durationSec,
      rung: "eporner-pool",
      url: entry.winner!.url,
      uploader: entry.winner!.uploader,
      title: entry.winner!.title,
      identityTier: entry.winner!.identityTier,
      lagDays: entry.winner!.lagDays,
      durationDeltaSec: entry.winner!.durationDeltaSec,
      candidatesConsidered: entry.gathered.considered,
      durationPassed: entry.gathered.survivorDurations.filter(
        (duration) => Math.abs(duration - (entry.scene.durationSec ?? 0)) <= tolerance,
      ).length,
      hydrated: entry.gathered.candidates.length,
      rejectedByDate: entry.dateRejected,
      unknownDate: entry.unknownDate,
    }));

    const report = {
      generatedAt: now.toISOString(),
      durationToleranceSec: tolerance,
      dateWindowDays: windowDays,
      index: {
        ok: indexReport.ok,
        totalIndexed: indexReport.totalIndexed,
        totalUndated: indexReport.totalUndated,
        uploaders: indexReport.uploaders,
      },
      sample: {
        eligible: eligible.length,
        considered: sample.length,
        matched: matched.length,
        matchRate: sample.length ? matched.length / sample.length : 0,
      },
      // The measurements the window's value should be read against.
      lagHistogram,
      funnel,
      identityTiers: tierHistogram,
      durationDelta,
      unknownDates: {
        // Pool only. The remaining rung, sxyprn, supplies its date on the post
        // detail it already fetched, so its unknown count adds no requests and
        // appears in the sync run log's per-rung rejection counters instead.
        "eporner-pool": results.reduce((total, entry) => total + entry.unknownDate, 0),
        sxyprn: "reported in the sync run log",
      },
      hydrationCappedScenes: hydrationCapped,
      accepted,
    };

    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    log.info("calibrate finished", {
      tolerance,
      windowDays,
      ...funnel,
      identityTiers: tierHistogram,
      scanTolerance,
      anchoredPairs: anchoredPairCount,
      scenesWithAnchoredCandidate,
    });
  } finally {
    store.close();
  }
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`calibrate failed: ${(error as Error).message}\n`);
  process.exit(1);
}
