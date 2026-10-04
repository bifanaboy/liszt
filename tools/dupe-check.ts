/** Throwaway live check: run a real full sync, then look for duplicate releases. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { createSources } from "../src/sources/registry.ts";
import { createSync } from "../src/pipeline/sync.ts";
import { createPoolLookup } from "../src/tubes/eporner-pool.ts";
import { createFc2EpornerResolver } from "../src/tubes/fc2-eporner.ts";
import { HttpFetcher } from "../src/core/fetcher.ts";
import { JsonLogger } from "../src/core/logger.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { systemClock } from "../src/sources/types.ts";
import { cleanStudioName } from "../src/sources/studio-identity.ts";

const config = loadConfig();
const dbPath = join(mkdtempSync(join(tmpdir(), "liszt-dupe-")), "liszt.db");
const store = new SqliteStore(dbPath);
store.migrate();
// Sync is chatty; only warnings and worse are interesting for a duplicate hunt.
const logger = new JsonLogger(process.stdout);
const log = {
  debug: () => {},
  info: () => {},
  warn: (message: string, fields?: Record<string, unknown>) => logger.warn(message, fields ?? {}),
  error: (message: string, fields?: Record<string, unknown>) => logger.error(message, fields ?? {}),
  child: () => log,
};

const sources = createSources({
  madouquApiBase: config.madouquApiBase,
  traxxxWatchlist: config.traxxxWatchlist,
  fc2: {
    listingMinIntervalMs: config.fc2ListingMinIntervalMs,
    detailMinIntervalMs: config.fc2DetailMinIntervalMs,
    maxDetailChecksPerSync: config.fc2MaxDetailChecksPerSync,
    recheckDays: config.fc2RecheckDays,
  },
  manyvidsStoreIds: config.manyvidsStoreIds,
  manyvidsMinIntervalMs: config.manyvidsMinIntervalMs,
  store,
  tpdbApiKey: config.tpdbApiKey,
  studioLinks: config.studioLinks,
});

const fetcher = new HttpFetcher(config.fetchTimeoutMs);
const poolLookup = createPoolLookup({
  store,
  fetcher,
  uploaders: config.trustedUploaders,
  durationToleranceSec: config.matchDurationToleranceSec,
  dateWindowDays: config.matchDateWindowDays,
  log: () => {},
});

const runSync = createSync({
  store,
  sources,
  fetcher,
  clock: systemClock,
  log,
  windowDays: config.windowDays,
  fetchConcurrency: config.fetchConcurrency,
  traxxx: { minIntervalMs: config.traxxxMinIntervalMs, cacheTtlMs: config.traxxxCacheTtlMs },
  lookups: { poolLookup, sxyprnLookup: null, fc2Lookup: createFc2EpornerResolver(fetcher) },
});

const started = Date.now();
const summary = await runSync("live-duplicate-check");
process.stdout.write(`\nsync took ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
process.stdout.write(`summary ${JSON.stringify(summary).slice(0, 400)}\n\n`);

const now = systemClock.now();
const to = now.toISOString().slice(0, 10);
const from = new Date(now.getTime() - config.windowDays * 86_400_000).toISOString().slice(0, 10);
const scenes = store.listWindow(from, to);
process.stdout.write(`window scenes: ${scenes.length}\n`);

// A duplicate is the same release described by two different source lanes. The
// scene id is per-source, so this has to be compared on the release itself:
// same studio, same normalised title, same day.
const groups = new Map<string, typeof scenes>();
for (const scene of scenes) {
  const key = [
    cleanStudioName(scene.label || scene.source),
    cleanStudioName(scene.title),
    scene.releaseDate,
  ].join("|");
  groups.set(key, [...(groups.get(key) ?? []), scene]);
}
const dupes = [...groups.entries()].filter(([, rows]) => rows.length > 1);
process.stdout.write(`duplicate release groups: ${dupes.length}\n`);
for (const [key, rows] of dupes.slice(0, 15)) {
  process.stdout.write(`  ${key}\n    ${rows.map((r) => r.id).join("\n    ")}\n`);
}

// The same question per studio: how many rows does each studio label carry, and
// how many distinct titles?
const byStudio = new Map<string, { rows: number; titles: Set<string> }>();
for (const scene of scenes) {
  const label = scene.label || scene.source;
  const entry = byStudio.get(label) ?? { rows: 0, titles: new Set<string>() };
  entry.rows += 1;
  entry.titles.add(cleanStudioName(scene.title));
  byStudio.set(label, entry);
}
process.stdout.write("\nstudio            rows  distinctTitles\n");
for (const [label, entry] of [...byStudio].sort((a, b) => b[1].rows - a[1].rows)) {
  const flag = entry.titles.size < entry.rows ? "  <-- OVERLAP" : "";
  process.stdout.write(
    `  ${label.padEnd(34)} ${String(entry.rows).padStart(4)}  ${String(entry.titles.size).padStart(4)}${flag}\n`,
  );
}
store.close();
