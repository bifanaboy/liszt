import { config } from "hatchable";
import { loadConfig } from "./config.js";
import { HttpFetcher } from "./fetcher.js";
import { createStore } from "./store.js";
import { createSources, RETIRED_SOURCE_IDS } from "./sources/registry.js";
import { createPoolLookup, indexPool } from "./tubes/eporner-pool.js";
import { createFc2EpornerResolver } from "./tubes/fc2-eporner.js";
import { createSxyprnClient, createSxyprnRelayApi } from "./tubes/sxyprn-client.js";
import { createSxyprnLookup } from "./tubes/sxyprn.js";
import { createSync } from "./sync.js";
import { sanitizeFailureSummary } from "./logging.js";

function logger(secrets) {
  const clean = (value) => {
    if (typeof value === "string") return sanitizeFailureSummary(value, secrets);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)]));
    }
    return value;
  };
  return Object.fromEntries(
    ["debug", "info", "warn", "error"].map((level) => [
      level,
      (event, fields = {}) => {
        const entry = JSON.stringify(clean({ level, event, ...fields }));
        console[level === "debug" ? "log" : level](entry.slice(0, 2000));
      },
    ]),
  );
}

export async function runRefreshCycle(db, reason) {
  const options = await loadConfig(config);
  const store = createStore(db);
  const fetcher = new HttpFetcher(options.fetchTimeoutMs);
  const log = logger([options.tpdbApiKey, options.sxyprnRelaySecret].filter(Boolean));
  const sources = createSources({
    madouquApiBase: options.madouquApiBase,
    traxxxWatchlist: options.traxxxWatchlist,
    fc2: {
      listingMinIntervalMs: options.fc2ListingMinIntervalMs,
      detailMinIntervalMs: options.fc2DetailMinIntervalMs,
      maxDetailChecksPerSync: options.fc2MaxDetailChecksPerSync,
      recheckDays: options.fc2RecheckDays,
    },
    manyvidsStoreIds: options.manyvidsStoreIds,
    manyvidsMinIntervalMs: options.manyvidsMinIntervalMs,
    bangListingUrl: options.bangListingUrl,
    store,
    tpdbApiKey: options.tpdbApiKey,
    studioLinks: options.studioLinks,
  });
  const poolLookup = createPoolLookup({
    store,
    fetcher,
    uploaders: options.trustedUploaders,
    durationToleranceSec: options.matchDurationToleranceSec,
    dateWindowDays: options.matchDateWindowDays,
    log: (event, fields) => log.debug(event, fields),
  });
  const relayApi =
    options.sxyprnRelayUrl && options.sxyprnRelaySecret
      ? createSxyprnRelayApi({ url: options.sxyprnRelayUrl, secret: options.sxyprnRelaySecret })
      : null;
  const sxyprnClient = relayApi
    ? createSxyprnClient(relayApi, { timeoutMs: options.sxyprnTimeoutMs })
    : null;
  const sxyprnLookup = sxyprnClient
    ? createSxyprnLookup({
        client: sxyprnClient,
        dateWindowDays: options.matchDateWindowDays,
        durationToleranceSec: options.matchDurationToleranceSec,
      })
    : null;

  try {
    const report = await indexPool({
      store,
      fetcher,
      now: new Date(),
      uploaders: options.trustedUploaders,
      windowDays: options.windowDays,
      fullRewalkDays: options.poolFullRewalkDays,
      log: (event, fields) => log.info(event, fields),
    });
    if (!report.ok)
      log.warn("pool index incomplete", {
        failed: report.uploaders.filter((item) => item.error).length,
      });
  } catch (error) {
    log.warn("pool index failed", {
      summary: String(error?.message ?? "unknown failure").slice(0, 200),
    });
  }

  const sync = createSync({
    store,
    sources,
    retiredSourceIds: RETIRED_SOURCE_IDS,
    fetcher,
    clock: { now: () => new Date() },
    log,
    windowDays: options.windowDays,
    fetchConcurrency: options.fetchConcurrency,
    traxxx: { minIntervalMs: options.traxxxMinIntervalMs, cacheTtlMs: options.traxxxCacheTtlMs },
    lookups: {
      poolLookup,
      sxyprnLookup,
      fc2Lookup: createFc2EpornerResolver(fetcher),
      ...(sxyprnClient ? { sxyprnRequests: () => sxyprnClient.takeRequests() } : {}),
    },
    logSecrets: [options.tpdbApiKey, options.sxyprnRelaySecret].filter(Boolean),
  });
  return sync(reason);
}
