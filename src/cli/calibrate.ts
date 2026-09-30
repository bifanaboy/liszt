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
 *   4. Print accepted link samples to eyeball by hand before trusting them.
 *
 * WHY THE HISTOGRAM IS NOT COMPUTED FROM THE WINNERS. A histogram of the links
 * you already accepted cannot show the tail the window exists to cut off, so it
 * would quietly justify whatever value the window already has. It is computed
 * from the full duration-surviving set instead, which is the set the window
 * actually gets to choose from.
 *
 * The JSON report goes to stdout; logs go to stderr.
 */
import { parseArgs } from "node:util";
import { loadConfig } from "../config.ts";
import { HttpFetcher } from "../core/fetcher.ts";
import { JsonLogger } from "../core/logger.ts";
import { SqliteStore } from "../core/store/sqlite.ts";
import { mapIsolated, mapWithConcurrency } from "../core/concurrency.ts";
import { pickMatch, withinDateWindow, type IdentityTier } from "../core/matching.ts";
import { createSources } from "../sources/registry.ts";
import {
  gatherPoolSurvivors,
  indexPool,
  type PoolSurvivors,
} from "../tubes/eporner-pool.ts";
import { normaliseScene, dateOnly } from "../pipeline/sync.ts";
import { buildMatchScene } from "../tubes/resolve.ts";
import type { MatchScene, Rung } from "../tubes/types.ts";
import type { Scene } from "../core/schema.ts";

/** The traxxx lanes: the only lanes with measured trusted-pool coverage. */
const TRAXXX_LANE_IDS = new Set(["lancelot-styles-evolution", "mambo-perv", "tushy"]);

const DAY_MS = 86_400_000;

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
  } | null;
  dateRejected: number;
  unknownDate: number;
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
  "lag-0d", "lag-1d", "lag-1-2d", "lag-3-5d", "lag-6-7d", "lag-8-14d",
  "lag-15d+", "before-window", "unknown",
];

function emptyLagHistogram(): Record<LagBucket, number> {
  return Object.fromEntries(BUCKET_ORDER.map((bucket) => [bucket, 0])) as Record<LagBucket, number>;
}

function emptyTierHistogram(): Record<"0" | "1" | "2" | "3", number> {
  return { "0": 0, "1": 0, "2": 0, "3": 0 };
}

/** Days from the release date to an upload date; null if either is unreadable. */
function lagDays(releaseDate: string, added: string | null): number | null {
  const release = Date.parse(releaseDate);
  const uploaded = Date.parse(added ?? "");
  if (!Number.isFinite(release) || !Number.isFinite(uploaded)) return null;
  return Math.round((uploaded - release) / DAY_MS);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      limit: { type: "string", default: "50" },
      tolerance: { type: "string" },
      window: { type: "string" },
      samples: { type: "string", default: "10" },
      "no-index": { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const config = loadConfig();
  const log = new JsonLogger({ component: "calibrate" }, (line) => process.stderr.write(`${line}\n`));
  const store = new SqliteStore(config.dbPath);
  store.migrate();
  const fetcher = new HttpFetcher(config.fetchTimeoutMs);
  const now = new Date();
  const limit = Math.max(1, Number(values.limit) || 50);
  const tolerance = values.tolerance ? Number(values.tolerance) : config.matchDurationToleranceSec;
  const windowDays = values.window ? Number(values.window) : config.matchDateWindowDays;
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
          mapWithConcurrency: (items, task) => mapWithConcurrency(items, task, config.fetchConcurrency),
          mapIsolated: (items, task) => mapIsolated(items, task, config.fetchConcurrency),
        });
        for (const raw of result.scenes) {
          const scene: Scene = normaliseScene(adapter, raw, now);
          matchScenes.push(buildMatchScene(scene, adapter.creatorStudio ?? false));
        }
      } catch (error) {
        log.warn("calibrate: a traxxx lane failed", { source: adapter.id, error: (error as Error).message });
      }
    }

    // A performer-less scene is ELIGIBLE under the current rule - it simply
    // ranks on fewer signals - so calibration must include it. Filtering it out
    // here would measure a stricter gate than the one that ships, and would
    // hide exactly the tier-0 decoy risk the histogram exists to catch.
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
            durationToleranceSec: tolerance,
            dateWindowDays: windowDays,
            log: (message, fields) => log.debug(message, fields),
          },
          now,
        );
        // The same call the rung makes, so the winner the histogram counts is
        // the winner the ladder would have written.
        const checks = gathered.candidates.map((candidate) =>
          withinDateWindow(scene.releaseDate, candidate.added, windowDays),
        );
        const inWindow = gathered.candidates.filter((_, index) => checks[index] === true);
        const picked = pickMatch(scene, inWindow, {
          durationToleranceSec: tolerance,
          dateWindowDays: windowDays,
        });
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
              }
            : null,
          dateRejected: checks.filter((check) => check === false).length,
          unknownDate: checks.filter((check) => check === "unknown").length,
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

    const funnel = {
      scenesConsidered: sample.length,
      indexRowsExamined: results.reduce((total, entry) => total + entry.gathered.considered, 0),
      durationPassed: results.reduce((total, entry) => total + entry.gathered.durationPassed, 0),
      datePassed: results.reduce(
        (total, entry) =>
          total +
          entry.gathered.candidates.filter(
            (candidate) => withinDateWindow(entry.scene.releaseDate, candidate.added, windowDays) === true,
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
      candidatesConsidered: entry.gathered.considered,
      durationPassed: entry.gathered.durationPassed,
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
      // The four measurements the window's value should be read against.
      lagHistogram,
      funnel,
      identityTiers: tierHistogram,
      unknownDates: {
        // Pool only. Rungs 2 and 3 supply their date on the row they already
        // fetched, so they add no requests and their unknown counts appear in
        // the sync run log's per-rung rejection counters instead.
        "eporner-pool": results.reduce((total, entry) => total + entry.unknownDate, 0),
        sxyprn: "reported in the sync run log",
        "eporner-open": "reported in the sync run log",
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
