/**
 * The composition root. This is the only place concrete implementations are
 * wired to the contracts the pipeline depends on.
 *
 * The boot order matters and is deliberate:
 *
 *   1. Parse configuration. There is no credential to check and nothing that
 *      can refuse to start for a missing secret - the app has no perimeter.
 *   2. Open and migrate the store (WAL + busy timeout) before anything reads it.
 *   3. Build the ladder's lookups once: the pool index handle and the optional
 *      lazily-loaded sxyprn client.
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
import { createSources } from "./sources/registry.ts";
import { systemClock } from "./sources/types.ts";
import { createSync } from "./pipeline/sync.ts";
import { createProgressTracker } from "./pipeline/progress.ts";
import { createScheduler, createSingleFlight } from "./pipeline/scheduler.ts";
import { createPoolLookup, indexPool } from "./tubes/eporner-pool.ts";
import { createSxyprnLookup } from "./tubes/sxyprn.ts";
import { loadSxyprnClient } from "./tubes/sxyprn-client.ts";
import { buildReadModel } from "./serving/read-model.ts";
import { createHttpServer } from "./serving/http.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");

/**
 * The absolute ceiling on how long shutdown may take, armed at signal receipt.
 *
 * The scheduler's own guard is 30s, so this has to exceed it or the process
 * exits while the cycle it was waiting for is still running. `render.yaml` sets
 * `maxShutdownDelaySeconds: 60`, which must exceed THIS value, or the platform
 * SIGKILLs the process before it has finished waiting.
 */
const SHUTDOWN_BACKSTOP_MS = 45_000;

async function main(): Promise<void> {
  const config = loadConfig();
  const log = new JsonLogger(
    { app: "liszt" },
    config.logToStderr ? (line) => process.stderr.write(`${line}\n`) : undefined,
  );

  const store = new SqliteStore(config.dbPath);
  store.migrate();

  const fetcher = new HttpFetcher(config.fetchTimeoutMs);
  const sources = createSources({
    madouquApiBase: config.madouquApiBase,
    ...(config.maximoListingUrl ? { maximoListingUrl: config.maximoListingUrl } : {}),
  });

  // Rung 2 is optional. A missing package is a calm state, not a crash.
  const sxyprnClient = await loadSxyprnClient({ timeoutMs: config.sxyprnTimeoutMs });
  if (!sxyprnClient) log.info("optional sxyprn client not installed; rung 2 stays disabled");

  const poolLookup = createPoolLookup({
    store,
    fetcher,
    uploaders: config.trustedUploaders,
    durationToleranceSec: config.matchDurationToleranceSec,
    dateWindowDays: config.matchDateWindowDays,
    log: (message, fields) => log.debug(message, fields),
  });
  const sxyprnLookup = sxyprnClient
    ? createSxyprnLookup({
        client: sxyprnClient,
        dateWindowDays: config.matchDateWindowDays,
        durationToleranceSec: config.matchDurationToleranceSec,
      })
    : null;

  // One tracker for the whole cycle, begun here because the pool index runs
  // BEFORE `createSync` and is the longest cold-start phase. It is the single
  // source of progress for all three refresh triggers, because all three go
  // through `runCycle` - a second refresh joins the one already running, so
  // there is only ever one run to describe.
  const progress = createProgressTracker();
  const sync = createSync({
    store,
    sources,
    fetcher,
    clock: systemClock,
    log,
    windowDays: config.windowDays,
    fetchConcurrency: config.fetchConcurrency,
    traxxx: { minIntervalMs: config.traxxxMinIntervalMs, cacheTtlMs: config.traxxxCacheTtlMs },
    lookups: { poolLookup, sxyprnLookup },
    progress,
  });

  let inFlight = false;
  const runCycle = createSingleFlight(async () => {
    inFlight = true;
    const startedAt = new Date();
    progress.begin(`cycle-${startedAt.getTime()}`, startedAt.toISOString(), {
      sources: sources.length,
      uploaders: config.trustedUploaders.length,
    });
    try {
      try {
        const report = await indexPool({
          store,
          fetcher,
          now: new Date(),
          uploaders: config.trustedUploaders,
          windowDays: config.windowDays,
          fullRewalkDays: config.poolFullRewalkDays,
          log: (message, fields) => log.info(message, fields),
          onUploader: (done, total, uploader) => progress.indexStep(done, total, uploader),
        });
        if (!report.ok) {
          log.warn("pool index incomplete", {
            failed: report.uploaders.filter((entry) => entry.error).map((entry) => entry.uploader),
          });
        }
        // A full re-walk that could not reach the end of a listing deletes
        // nothing, so upstream deletions stay uncorrected until one completes.
        // It is not an error, but it is also not health - reported here rather
        // than only as a per-account truncation log line.
        const skipped = report.uploaders.filter((entry) => entry.pruneSkipped);
        if (skipped.length) {
          log.warn("pool index: absence prune withheld", {
            uploaders: skipped.map((entry) => entry.uploader),
          });
        }
      } catch (error) {
        // The pool is an optimisation; its failure must not stop the sync.
        log.warn("pool index failed", { error: (error as Error).message });
      }
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
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.listenAddr, resolve);
  });
  log.info("listening", {
    port: config.port,
    host: config.listenAddr,
    // Worth saying once at boot rather than on every request: this process has
    // no auth, no sessions and no secrets. Anyone who can reach the port can
    // read the catalogue and trigger a refresh.
    perimeter: "none",
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
      .then((clean) => {
        if (!clean) {
          log.error("shutdown gave up on an in-flight cycle; leaving the store open", {
            signal,
          });
          // No `server.close()` here, and that is deliberate. This process is
          // being abandoned: a cycle is still writing, so the store stays open
          // and the exit is reported as a failure. Calling `server.close()`
          // first would look like it was draining in-flight requests, but
          // `process.exit` on the next line kills the process before any
          // connection could finish - a no-op that misrepresents what happened.
          clearTimeout(hardExit);
          process.exit(1);
          return;
        }
        server.close(() => {
          store.close();
          clearTimeout(hardExit);
          process.exit(0);
        });
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
