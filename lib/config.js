import { DEFAULT_TIMEOUT_MS } from "./fetcher.js";
import { TRAXXX_WATCHLIST } from "./sources/traxxx-watchlist.js";
import { DEFAULT_STUDIO_LINKS } from "./studio-links.js";

export const DEFAULT_MADOUQU_API_BASE = "https://public-api.wordpress.com/wp/v2/sites/madouqu.com";
export const DEFAULT_TRUSTED_UPLOADERS = Object.freeze([
  "BigPussy86",
  "thor1488",
  "xdf1xd",
  "patronp1987",
  "WherbetAguiar",
  "trainwrecx",
  "Chicocunha420",
  "prehistorique",
  "mjalucard",
  "moskvitch",
  "brethrenm00n015",
  "Ben670",
  "wmartos",
  "diggler888",
  "rafellino",
  "rogerrfd",
  "Rajshot",
  "strangerdanger13",
  "avmatome",
  "Ivel44",
  "Zoloperno",
  "Leon99",
  "XINTERX",
  "TwitchXX",
  "McCreepin",
  "Vovick17",
  "KJUIUI",
  "Rafael12021988",
  "wmrt0s",
]);

function number(values, key, fallback, { min = 0, max = Infinity, integer = true } = {}) {
  const value = values[key];
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    (integer && !Number.isInteger(parsed)) ||
    parsed < min ||
    parsed > max
  ) {
    throw new Error(
      `Invalid configuration: ${key} must be ${integer ? "an integer" : "a number"} from ${min} to ${max}`,
    );
  }
  return parsed;
}

function textList(value, fallback) {
  const entries = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : null;
  if (entries === null) return [...fallback];
  const output = [...new Set(entries.map((entry) => String(entry).trim()).filter(Boolean))];
  return output.length ? output : [...fallback];
}

function url(value, key, fallback) {
  if (value == null || value === "") return fallback;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    return parsed.href;
  } catch {
    throw new Error(`Invalid configuration: ${key} must be an HTTP or HTTPS URL`);
  }
}

export async function loadConfig(config) {
  const keys = [
    "TPDB_API_KEY",
    "window_days",
    "fetch_concurrency",
    "fetch_timeout_ms",
    "traxxx_min_interval_ms",
    "traxxx_cache_ttl_ms",
    "traxxx_watchlist",
    "studio_links",
    "madouqu_api_base",
    "fc2_listing_min_interval_ms",
    "fc2_detail_min_interval_ms",
    "fc2_max_detail_checks_per_sync",
    "fc2_recheck_days",
    "manyvids_store_ids",
    "manyvids_min_interval_ms",
    "bang_listing_url",
    "trusted_uploaders",
    "match_duration_tolerance_sec",
    "match_date_window_days",
    "pool_full_rewalk_days",
  ];
  const values = Object.fromEntries(
    await Promise.all(keys.map(async (key) => [key, await config.get(key)])),
  );
  let studioLinks = DEFAULT_STUDIO_LINKS;
  if (values.studio_links) {
    try {
      studioLinks =
        typeof values.studio_links === "string"
          ? JSON.parse(values.studio_links)
          : values.studio_links;
    } catch {
      throw new Error("Invalid configuration: studio_links must be valid JSON");
    }
    if (
      !Array.isArray(studioLinks) ||
      studioLinks.some((item) => !item || typeof item !== "object")
    ) {
      throw new Error("Invalid configuration: studio_links must be a list of studio objects");
    }
  }
  const manyvidsStoreIds = textList(values.manyvids_store_ids, [
    "1003095958",
    "1009666091",
    "1002380360",
    "1000358477",
    "1003373430",
    "1002086327",
    "1007157741",
    "1001411388",
    "1000948867",
    "1007921628",
  ]);
  if (manyvidsStoreIds.some((id) => !/^\d+$/.test(id))) {
    throw new Error("Invalid configuration: manyvids_store_ids must contain numeric store IDs");
  }
  const matchDurationToleranceSec = number(values, "match_duration_tolerance_sec", 1, {
    min: 0,
    integer: false,
  });
  if (matchDurationToleranceSec <= 0) {
    throw new Error("Invalid configuration: match_duration_tolerance_sec must be positive");
  }
  return {
    tpdbApiKey:
      typeof values.TPDB_API_KEY === "string" && values.TPDB_API_KEY.trim()
        ? values.TPDB_API_KEY.trim()
        : undefined,
    windowDays: number(values, "window_days", 90, { min: 1 }),
    fetchConcurrency: number(values, "fetch_concurrency", 4, { min: 1, max: 16 }),
    fetchTimeoutMs: number(values, "fetch_timeout_ms", DEFAULT_TIMEOUT_MS, { min: 1 }),
    traxxxMinIntervalMs: number(values, "traxxx_min_interval_ms", 250),
    traxxxCacheTtlMs: number(values, "traxxx_cache_ttl_ms", 300_000, { min: 1 }),
    traxxxWatchlist: textList(values.traxxx_watchlist, TRAXXX_WATCHLIST),
    studioLinks,
    madouquApiBase: url(values.madouqu_api_base, "madouqu_api_base", DEFAULT_MADOUQU_API_BASE),
    fc2ListingMinIntervalMs: number(values, "fc2_listing_min_interval_ms", 2000),
    fc2DetailMinIntervalMs: number(values, "fc2_detail_min_interval_ms", 8500),
    fc2MaxDetailChecksPerSync: number(values, "fc2_max_detail_checks_per_sync", 20),
    fc2RecheckDays: number(values, "fc2_recheck_days", 7),
    manyvidsStoreIds,
    manyvidsMinIntervalMs: number(values, "manyvids_min_interval_ms", 400),
    bangListingUrl: url(
      values.bang_listing_url,
      "bang_listing_url",
      "https://www.bang.com/videos?by=date.desc",
    ),
    trustedUploaders: textList(values.trusted_uploaders, DEFAULT_TRUSTED_UPLOADERS),
    matchDurationToleranceSec,
    matchDateWindowDays: number(values, "match_date_window_days", 7, { min: 1 }),
    poolFullRewalkDays: number(values, "pool_full_rewalk_days", 7, { min: 1 }),
  };
}
