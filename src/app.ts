/**
 * The composition root. This is the only place concrete implementations are
 * wired to the contracts the pipeline depends on.
 *
 * The boot order matters and is deliberate:
 *
 *   1. Parse configuration and REFUSE to start without an auth hash in
 *      production - the password is the app's entire perimeter.
 *   2. Open and migrate the store (WAL + busy timeout) before anything reads it.
 *   3. Build the ladder's lookups once: the pool index handle, the optional
 *      lazily-loaded sxyprn client, and the eporner open search.
 *   4. LISTEN FIRST, then run the boot sync in the background, then start the
 *      interval. A slow first sync must not delay the port coming up.
 *   5. All three entry points - boot sync, interval, and `POST /api/refresh` -
 *      funnel through ONE single-flight runner, so two cycles can never overlap.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAuthConfigured, loadConfig } from "./config.ts";
import { verifyPassword } from "./auth/password.ts";
import { createSessionService } from "./auth/session.ts";
import { LoginThrottle } from "./auth/throttle.ts";
import { HttpFetcher } from "./core/fetcher.ts";
import { JsonLogger } from "./core/logger.ts";
import { SqliteStore } from "./core/store/sqlite.ts";
import { createSources } from "./sources/registry.ts";
import { systemClock } from "./sources/types.ts";
import { createSync } from "./pipeline/sync.ts";
import { createScheduler, createSingleFlight } from "./pipeline/scheduler.ts";
import { createEpornerOpenLookup, createEpornerOpenSearch } from "./tubes/eporner.ts";
import { createPoolLookup, indexPool } from "./tubes/eporner-pool.ts";
import { createSxyprnLookup } from "./tubes/sxyprn.ts";
import { loadSxyprnClient } from "./tubes/sxyprn-client.ts";
import { buildReadModel } from "./serving/read-model.ts";
import { createHttpServer } from "./serving/http.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, "..", "public");
const HOUR_MS = 3_600_000;

async function main(): Promise<void> {
  const config = loadConfig();
  assertAuthConfigured(config);
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
  const openLookup = createEpornerOpenLookup(
    createEpornerOpenSearch({ fetcher, lq: config.epornerLq }),
    { durationToleranceSec: config.matchDurationToleranceSec, dateWindowDays: config.matchDateWindowDays },
  );
  const sxyprnLookup = sxyprnClient
    ? createSxyprnLookup({
        client: sxyprnClient,
        dateWindowDays: config.matchDateWindowDays,
        durationToleranceSec: config.matchDurationToleranceSec,
      })
    : null;

  const sync = createSync({
    store,
    sources,
    fetcher,
    clock: systemClock,
    log,
    windowDays: config.windowDays,
    fetchConcurrency: config.fetchConcurrency,
    traxxx: { minIntervalMs: config.traxxxMinIntervalMs, cacheTtlMs: config.traxxxCacheTtlMs },
    lookups: { poolLookup, sxyprnLookup, openLookup },
  });

  let inFlight = false;
  const runCycle = createSingleFlight(async () => {
    inFlight = true;
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
        });
        if (!report.ok) {
          log.warn("pool index incomplete", {
            failed: report.uploaders.filter((entry) => entry.error).map((entry) => entry.uploader),
          });
        }
      } catch (error) {
        // The pool is an optimisation; its failure must not stop the sync.
        log.warn("pool index failed", { error: (error as Error).message });
      }
      return await sync("cycle");
    } finally {
      inFlight = false;
    }
  });

  const sessions = createSessionService(store, { ttlDays: config.sessionTtlDays });
  const throttle = new LoginThrottle({
    maxFailures: config.loginMaxFailures,
    lockoutMinutes: config.loginLockoutMinutes,
    now: () => Date.now(),
  });

  const server = createHttpServer({
    config,
    store,
    log,
    sessions,
    throttle,
    readModel: () => buildReadModel(store, config, new Date(), { refreshing: inFlight }),
    refresh: runCycle,
    isBusy: () => inFlight,
    publicDir: PUBLIC_DIR,
    cookieSecure: process.env.NODE_ENV === "production",
    verifyPassword,
  });

  await new Promise<void>((resolve) => {
    server.listen(config.port, config.listenAddr, resolve);
  });
  log.info("listening", {
    port: config.port,
    host: config.listenAddr,
    authDisabled: config.authDisabled,
  });

  // Housekeeping: expired sessions and stale throttle entries.
  sessions.purge(new Date());
  const maintenance = setInterval(() => {
    sessions.purge(new Date());
    throttle.sweep();
  }, HOUR_MS);
  maintenance.unref?.();

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
    scheduler.stop();
    clearInterval(maintenance);
    server.close(() => {
      store.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5_000).unref?.();
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