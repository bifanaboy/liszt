/**
 * Supported Node runtime composition root. It wires concrete implementations
 * to pipeline contracts, then starts the private browser app and refresh loop.
 *
 * The boot order matters and is deliberate:
 *
 *   1. Parse configuration. TPDB remains optional until `TPDB_API_KEY` is set.
 *   2. Open and migrate the store (WAL + busy timeout) before anything reads it.
 *   3. Build the Eporner search and optional Sxyprn lookup once.
 *   4. LISTEN FIRST, then run the boot sync in the background, then start the
 *      interval. A slow first sync must not delay the port coming up.
 *   5. All three entry points - boot sync, interval, and `POST /api/refresh` -
 *      funnel through ONE single-flight runner, so two cycles can never overlap.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { HttpFetcher } from "./core/fetcher.ts";
import { JsonLogger } from "./core/logger.ts";
import { SqliteStore } from "./core/store/sqlite.ts";
import { createSources, RETIRED_SOURCE_IDS } from "./sources/registry.ts";
import { systemClock } from "./sources/types.ts";
import { createSync } from "./pipeline/sync.ts";
import { createProgressTracker } from "./pipeline/progress.ts";
import { createScheduler, createSingleFlight } from "./pipeline/scheduler.ts";
import { createEpornerOpenLookup, createEpornerOpenSearch } from "./tubes/eporner.ts";
import { createSxyprnLookup, createSxyprnSearch } from "./tubes/sxyprn.ts";
import { createFc2EpornerResolver } from "./tubes/fc2-eporner.ts";
import { buildReadModel } from "./serving/read-model.ts";
import { createHttpServer } from "./serving/http.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

/**
 * The local reference server waits up to 45 seconds for an active cycle to stop.
 */
const SHUTDOWN_BACKSTOP_MS = 45_000;

async function main(): Promise<void> {
  const config = loadConfig(process.env, { requireAuth: true });
  const log = new JsonLogger(
    { app: "liszt" },
    config.logToStderr ? (line) => process.stderr.write(`${line}\n`) : undefined,
    [config.authUsername ?? "", config.authPassword ?? "", config.tpdbApiKey ?? ""],
  );

  const store = new SqliteStore(config.dbPath);
  store.migrate();

  const fetcher = new HttpFetcher(config.fetchTimeoutMs);
  const sources = createSources({
    madouquApiBase: config.madouquApiBase,
    traxxxWatchlist: config.traxxxWatchlist,
    fc2: {
      listingMinIntervalMs: config.fc2ListingMinIntervalMs,
    },
    manyvidsStoreIds: config.manyvidsStoreIds,
    manyvidsMinIntervalMs: config.manyvidsMinIntervalMs,
    store,
    tpdbApiKey: config.tpdbApiKey,
    studioLinks: config.studioLinks,
  });

  // Sxyprn is a direct fetch through the shared fetcher: the search page
  // answers 200 with a browser User-Agent (measured 2026-10-10), so there is
  // no package to load and nothing to gate on.
  const sxyprnSearch = createSxyprnSearch(fetcher);

  const epornerLookup = createEpornerOpenLookup(createEpornerOpenSearch({ fetcher }), {
    durationToleranceSec: config.matchDurationToleranceSec,
    dateWindowDays: config.matchDateWindowDays,
  });
  const sxyprnLookup = createSxyprnLookup(sxyprnSearch, {
    durationToleranceSec: config.matchDurationToleranceSec,
  });
  const fc2Lookup = createFc2EpornerResolver(fetcher);

  // One tracker for the whole cycle, shared by all three refresh triggers,
  // because all three go
  // through `runCycle` - a second refresh joins the one already running, so
  // there is only ever one run to describe.
  const progress = createProgressTracker();
  let stopping = false;
  const sync = createSync({
    store,
    sources,
    retiredSourceIds: RETIRED_SOURCE_IDS,
    fetcher,
    clock: systemClock,
    log,
    windowDays: config.windowDays,
    fetchConcurrency: config.fetchConcurrency,
    traxxx: { minIntervalMs: config.traxxxMinIntervalMs, cacheTtlMs: config.traxxxCacheTtlMs },
    lookups: {
      epornerLookup,
      sxyprnLookup,
      fc2Lookup,
    },
    progress,
    secrets: [config.authUsername ?? "", config.authPassword ?? "", config.tpdbApiKey ?? ""],
  });

  let inFlight = false;
  const singleFlightCycle = createSingleFlight(async () => {
    inFlight = true;
    const startedAt = new Date();
    progress.begin(`cycle-${startedAt.getTime()}`, startedAt.toISOString(), {
      sources: sources.length,
      uploaders: 0,
    });
    try {
      return await sync("cycle");
    } finally {
      inFlight = false;
      // Belt and braces, and a no-op in every real path: `sync` ends the run
      // itself. This is the one place all three triggers converge, so a cycle
      // that somehow ended without narrating an end - a throw between the pool
      // index and the sync - cannot leave the dashboard showing a bar that will
      // never move again.
      if (progress.snapshot().active) progress.finish();
    }
  });
  let activeCycle: Promise<unknown> | null = null;
  const runCycle = (): Promise<unknown> => {
    const current = singleFlightCycle();
    activeCycle = current;
    void current.then(
      () => {
        if (activeCycle === current) activeCycle = null;
      },
      () => {
        if (activeCycle === current) activeCycle = null;
      },
    );
    return current;
  };

  const server = createHttpServer({
    store,
    log,
    readModel: () =>
      buildReadModel(store, config, new Date(), {
        refreshing: inFlight,
        progress: progress.snapshot(),
      }),
    refresh: runCycle,
    isBusy: () => inFlight,
    publicDir: PUBLIC_DIR,
    progress: () => progress.snapshot(),
    auth: { username: config.authUsername!, password: config.authPassword! },
    acceptingRequests: () => !stopping,
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.listenAddr, resolve);
  });
  log.info("listening", {
    port: config.port,
    host: config.listenAddr,
  });

  const scheduler = createScheduler({
    intervalMs: config.pollIntervalMinutes * 60_000,
    run: runCycle,
    log,
  });
  scheduler.start();

  if (config.bootSync) {
    // Listen first, sync second: the dashboard is reachable during the first run.
    runCycle().catch((error) => log.error("boot sync failed", { error: (error as Error).message }));
  }

  const shutdown = (signal: string): void => {
    log.info("shutting down", { signal });
    stopping = true;
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    // The backstop is armed AT SIGNAL RECEIPT, not inside the `.then()` below.
    // Armed there it could only start once the scheduler had already resolved,
    // so it bounded a slow `server.close` but not the thing its comment claimed
    // to bound: a `stop()` that never settles. Render SIGTERMs this process on
    // every single deploy, and then SIGKILLs it at
    // `maxShutdownDelaySeconds`, so the whole budget has to be spent before
    // that deadline or the platform kills the process mid-write to the SQLite
    // file on the attached disk.
    const hardExit = setTimeout(() => {
      log.error("shutdown timed out, exiting without closing the store", {
        signal,
        note: "an in-flight cycle may have been cut off mid-transaction",
      });
      process.exit(1);
    }, SHUTDOWN_BACKSTOP_MS);
    hardExit.unref?.();

    // The scheduler is stopped and its in-flight cycle AWAITED before the store
    // closes. `stop()` resolves false when its own 30s bound expired with the
    // cycle still running - in which case closing the store would pull the
    // handle out from under a live writer. WAL SQLite tolerates an unclosed
    // handle at process exit; it does not tolerate a write against a closed
    // one, so the close is skipped and the exit is reported as a failure.
    void scheduler
      .stop()
      .catch((error) => {
        log.error("scheduler stop failed", { error: (error as Error).message });
        return false;
      })
      .then(async () => {
        await serverClosed;
        // Scheduler.stop() only knows about timer-triggered work. Boot and
        // HTTP refreshes use the same single-flight runner, so drain that
        // shared promise too before closing SQLite.
        while (activeCycle) await activeCycle.catch(() => undefined);
        store.close();
        clearTimeout(hardExit);
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`liszt failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
