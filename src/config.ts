/**
 * Typed configuration, parsed once at startup so misconfiguration fails fast
 * and loudly. Two failure classes are kept distinct: a *missing credential* is
 * a deploy misconfiguration that earns a calm, named status, while a *source
 * outage* is a runtime error. They are not the same thing.
 */
import { z } from "zod";
import { DEFAULT_FETCH_CONCURRENCY } from "./core/concurrency.ts";
import { DEFAULT_TIMEOUT_MS } from "./core/fetcher.ts";
import { TRAXXX_WATCHLIST } from "./sources/traxxx-watchlist.ts";

/** The default trusted pool. Hand-curated; trust is never inferred. */
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

/**
 * madouqu.com is behind a Cloudflare challenge from most egress IPs, so the
 * WordPress.com mirror is the default. A VPS with stable egress can point
 * `LISZT_MADOUQU_API_BASE` at the direct `/wp-json`.
 */
export const DEFAULT_MADOUQU_API_BASE = "https://public-api.wordpress.com/wp/v2/sites/madouqu.com";

export const Config = z.object({
  port: z.coerce.number().int().positive().default(3000),
  /**
   * The bind address. Loopback by design: production is fronted by a Cloudflare
   * Tunnel, so nothing needs to reach the port directly and nothing should be
   * able to. Override ONLY for a platform that fronts the process with its own
   * proxy (see render.yaml).
   */
  listenAddr: z.string().min(1).default("127.0.0.1"),
  dbPath: z.string().min(1).default("data/liszt.db"),
  /** Optional TPDB credential. Never included in logs or HTTP responses. */
  tpdbApiKey: z.string().min(1).optional(),
  windowDays: z.coerce.number().int().positive().default(90),
  pollIntervalMinutes: z.coerce.number().int().positive().default(30),
  /** Run one sync on boot, in the background behind the listening port. */
  bootSync: z.boolean().default(true),
  fetchConcurrency: z.coerce.number().int().min(1).max(16).default(DEFAULT_FETCH_CONCURRENCY),
  fetchTimeoutMs: z.coerce.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  /**
   * Per-call deadline for the optional sxyprn source, measured from the moment
   * the call holds the source's request slot. The package paces itself at one
   * request every 10s, and that wait is deliberately outside this number.
   */
  sxyprnTimeoutMs: z.coerce.number().int().positive().default(15_000),
  /** Minimum spacing between traxxx.me requests, and its per-run cache TTL. */
  traxxxMinIntervalMs: z.coerce.number().int().nonnegative().default(250),
  traxxxCacheTtlMs: z.coerce.number().int().positive().default(300_000),
  traxxxWatchlist: z.array(z.string().min(1)).default([...TRAXXX_WATCHLIST]),
  madouquApiBase: z.string().url().default(DEFAULT_MADOUQU_API_BASE),
  /** Unset: the Maximo Garcia lane reports "not configured" and stays calm. */
  maximoListingUrl: z.string().url().optional(),

  // FC2 lane (fc2cmadb.com). The site answers slowly and asks to be walked
  // gently, so both spacings are named here instead of buried in the adapter.
  /** Minimum spacing between listing pages. The site asks for 2s. */
  fc2ListingMinIntervalMs: z.coerce.number().int().nonnegative().default(2000),
  /**
   * Minimum spacing between DETAIL pages, measured safe at 8-9s. It is the
   * dominant cost of the lane: a 90-day anal-tag window is a few hundred
   * candidates and each one costs this delay, so the sync is also bounded per
   * run and resumes on the next one.
   */
  fc2DetailMinIntervalMs: z.coerce.number().int().nonnegative().default(8500),
  /** How many detail pages one sync may read before deferring the rest. */
  fc2MaxDetailChecksPerSync: z.coerce.number().int().nonnegative().default(20),
  /**
   * How long an unmarked censorship badge is retried before the candidate is
   * retired from pending work undecided. It is never classified as censored and
   * never accepted; it just stops costing requests.
   */
  fc2RecheckDays: z.coerce.number().int().nonnegative().default(7),

  manyvidsStoreIds: z.array(z.string().regex(/^\d+$/)).default(["1003095958"]),
  manyvidsMinIntervalMs: z.coerce.number().int().min(0).default(400),

  // Tube ladder.
  trustedUploaders: z.array(z.string().min(1)).default([...DEFAULT_TRUSTED_UPLOADERS]),
  /**
   * Duration gate, applied identically on every rung. Not per-rung.
   *
   * Duplicated from `MATCH_DURATION_TOLERANCE_SEC` rather than imported, because
   * this file is the configuration schema and that constant is the rule - a
   * config module importing the thing it configures makes the dependency
   * circular. The two must agree: over the 46 links the live service held on
   * 2026-09-30, every winner carrying identity evidence sat at exactly 0s, and
   * all 20 winners at 1s or 2s were the wrong video. See the constant for the
   * table and for what would overturn it.
   */
  matchDurationToleranceSec: z.coerce.number().positive().default(1),
  /**
   * The upload window's upper bound. The lower bound is fixed at
   * `release - 1 day` and is not a knob: it is the pre-release-leak margin.
   *
   * This is a starting point, not a measured optimum - `npm run calibrate`
   * reports the lag histogram it should be read against. Above roughly three
   * weeks the rule stops doing useful work and should be deleted rather than
   * tuned.
   */
  matchDateWindowDays: z.coerce.number().int().positive().default(7),
  poolFullRewalkDays: z.coerce.number().int().positive().default(7),

  /** JSON-line logs to stderr. The CLI sets this so stdout stays a result. */
  logToStderr: z.boolean().default(false),
});

export type Config = z.infer<typeof Config>;

/**
 * Strict boolean parsing for the environment.
 *
 * The previous form was `value === "1" || value.toLowerCase() === "true"`,
 * which is an OPEN list with an invisible default: everything not in it - `yes`,
 * `on`, `enabled`, and `treu` - silently became `false`. For a flag whose
 * `false` value DISABLES a control (boot sync, stderr logging) that failure is
 * invisible; for one whose `false` value enables a hole (`LISZT_AUTH_DISABLED`)
 * it is the opposite. So the list is closed and anything unrecognised is a
 * configuration error, which is the treatment every other field in this module
 * already gets.
 */
const BOOL_TRUE = new Set(["1", "true", "yes", "on"]);
const BOOL_FALSE = new Set(["0", "false", "no", "off", ""]);

export class ConfigValueError extends Error {
  constructor(key: string, value: string) {
    super(
      `Invalid configuration: ${key}="${value}" is not a boolean (use one of ${[...BOOL_TRUE].join(", ")} / ${[...BOOL_FALSE].slice(0, 4).join(", ")})`,
    );
    this.name = "ConfigValueError";
  }
}

const bool = (key: string, value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalised = value.trim().toLowerCase();
  if (BOOL_TRUE.has(normalised)) return true;
  if (BOOL_FALSE.has(normalised)) return false;
  throw new ConfigValueError(key, value);
};

const list = (value: string | undefined): string[] | undefined => {
  if (value === undefined) return undefined;
  const parsed = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return parsed.length ? parsed : undefined;
};

const optionalValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

/**
 * Parse configuration from the environment, naming any failing field.
 *
 * There is no credential and no production-only refusal any more. The app has
 * no perimeter: it is a disposable public read model, and the only secret it
 * ever had is gone.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = Config.safeParse({
    port: env.PORT,
    listenAddr: env.LISZT_LISTEN_ADDR,
    dbPath: env.LISZT_DB_PATH,
    tpdbApiKey: optionalValue(env.TPDB_API_KEY),
    windowDays: env.LISZT_WINDOW_DAYS,
    pollIntervalMinutes: env.LISZT_POLL_INTERVAL_MINUTES,
    bootSync:
      env.LISZT_BOOT_SYNC === undefined
        ? undefined
        : bool("LISZT_BOOT_SYNC", env.LISZT_BOOT_SYNC, true),
    fetchConcurrency: env.LISZT_FETCH_CONCURRENCY,
    fetchTimeoutMs: env.LISZT_FETCH_TIMEOUT_MS,
    sxyprnTimeoutMs: env.LISZT_SXYPRN_TIMEOUT_MS,
    traxxxMinIntervalMs: env.LISZT_TRAXXX_MIN_INTERVAL_MS,
    traxxxCacheTtlMs: env.LISZT_TRAXXX_CACHE_TTL_MS,
    traxxxWatchlist: list(env.LISZT_TRAXXX_WATCHLIST),
    madouquApiBase: env.LISZT_MADOUQU_API_BASE,
    maximoListingUrl: optionalValue(env.LISZT_MAXIMO_LISTING_URL),
    fc2ListingMinIntervalMs: env.LISZT_FC2_LISTING_MIN_INTERVAL_MS,
    fc2DetailMinIntervalMs: env.LISZT_FC2_DETAIL_MIN_INTERVAL_MS,
    fc2MaxDetailChecksPerSync: env.LISZT_FC2_MAX_DETAIL_CHECKS_PER_SYNC,
    fc2RecheckDays: env.LISZT_FC2_RECHECK_DAYS,
    manyvidsStoreIds:
      env.LISZT_MANYVIDS_STORE_IDS === undefined
        ? undefined
        : [
            ...new Set(
              env.LISZT_MANYVIDS_STORE_IDS.split(",")
                .map((value) => value.trim())
                .filter(Boolean),
            ),
          ],
    manyvidsMinIntervalMs: env.LISZT_MANYVIDS_MIN_INTERVAL_MS,
    trustedUploaders: list(env.LISZT_TRUSTED_UPLOADERS),
    matchDurationToleranceSec: env.LISZT_MATCH_DURATION_TOLERANCE_SEC,
    matchDateWindowDays: env.LISZT_MATCH_DATE_WINDOW_DAYS,
    poolFullRewalkDays: env.LISZT_POOL_FULL_REWALK_DAYS,
    logToStderr:
      env.LISZT_LOG_STDERR === undefined
        ? undefined
        : bool("LISZT_LOG_STDERR", env.LISZT_LOG_STDERR, false),
  });
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid configuration: ${detail}`);
  }
  return result.data;
}
