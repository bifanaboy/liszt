/**
 * The optional sxyprn client.
 *
 * The published `sxyprn` package is an optional runtime dependency, so it is
 * loaded LAZILY: when it is absent the ladder still runs and sxyprn scenes stay
 * unmatched (never guessed). A missing package is a calm state, not a crash.
 *
 * The package's v0.1.0 API is a default-exported object with `videos.search`
 * and `videos.details`. It retries a blocked request on its own unbounded
 * schedule and exposes no abort hook, so from a datacenter IP (where sxyprn
 * answers 403 behind Cloudflare) a single call could otherwise wedge the whole
 * sync. Two wrappers fix that, and both are load-bearing:
 *
 *  - `withDeadline` caps one call at `timeoutMs` and drains the abandoned
 *    promise so a late rejection is not an unhandled rejection.
 *  - A shared circuit breaker counts consecutive failures; after
 *    `maxConsecutiveFailures` the rung stops asking and the ladder moves on to
 *    eporner immediately rather than paying the deadline once per scene. The
 *    break is not permanent: after `cooldownMs` one half-open probe is allowed
 *    through, so a source that recovers (a blocked IP is a transient condition,
 *    not a permanent one) rejoins the ladder without a restart.
 *
 * Everything the matcher gates on is forwarded verbatim - including `uploadDate`
 * and `views`, which are NOT decoration. `details()` is the only pass that
 * carries a real date, so dropping either field here silently made the sxyprn
 * rung unable to admit anything.
 */
import type { SxyprnCard, SxyprnClient, SxyprnDetail } from "./sxyprn.ts";

interface PackageVideoSummary {
  url?: string;
  title?: string;
  duration?: string;
  durationSeconds?: number;
  isExternal?: boolean;
  author?: unknown;
  uploadDate?: string;
  sizeBytes?: number;
  views?: number | string;
}

interface PackageVideoList {
  videos?: PackageVideoSummary[];
}

interface PackageApi {
  videos: {
    search(keyword: string, options?: { page?: number }): Promise<PackageVideoList>;
    details(input?: { url?: string }): Promise<PackageVideoSummary & { streamUrl?: string }>;
  };
}

export interface SxyprnClientOptions {
  /** Cap one search/details call. */
  timeoutMs?: number;
  /** Treat the source as down after this many consecutive failures. */
  maxConsecutiveFailures?: number;
  /** How long the break holds before a single half-open probe is allowed. */
  cooldownMs?: number;
}

/**
 * `HH:MM:SS` (or `MM:SS`) to seconds. Returns null for anything unparseable, so
 * an absent or malformed duration stays absent instead of becoming `NaN` and
 * failing the gate for a reason the log cannot explain.
 */
export function durationStringToSeconds(value: string | undefined): number | null {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map((part) => Number(part));
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return numbers.reduce((total, part) => total * 60 + part, 0);
}

/** Prefer the numeric field, fall back to the rendered `HH:MM:SS` string. */
function durationSecondsOf(video: PackageVideoSummary): number | null {
  if (Number.isFinite(video.durationSeconds)) return video.durationSeconds as number;
  return durationStringToSeconds(video.duration);
}

export function createSxyprnClient(
  api: PackageApi,
  options: SxyprnClientOptions = {},
): SxyprnClient {
  const { timeoutMs = 15_000, maxConsecutiveFailures = 2, cooldownMs = 10 * 60_000 } = options;
  let consecutiveFailures = 0;
  let broken = false;
  let openedAt = 0;
  let probing = false;
  let lastError: Error = new Error("sxyprn unavailable");

  const close = (): void => {
    consecutiveFailures = 0;
    broken = false;
    probing = false;
    openedAt = 0;
  };

  const trip = (error: Error): void => {
    lastError = error;
    if (probing) {
      // The probe failed, so the source is still down. Restart the cooldown from
      // now rather than from the original break, and make no further attempt
      // until it elapses again - otherwise every call after a failed probe is
      // another probe, which is the "break" the breaker exists to avoid.
      probing = false;
      broken = true;
      openedAt = Date.now();
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= maxConsecutiveFailures) {
      broken = true;
      openedAt = Date.now();
    }
  };

  /**
   * Run one call under the deadline, counting success and failure into the
   * breaker.
   *
   * The call is a THUNK, not an already-started promise, so a source that throws
   * synchronously is counted like any other failure. Passing a promise meant a
   * synchronous throw escaped before the breaker could see it - and because the
   * throw happened after `guard()` had already claimed the half-open probe, the
   * breaker was left marked "probing" and refused every later call with no way
   * to recover but a restart.
   */
  const withDeadline = async <T>(call: () => Promise<T>, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    let pending: Promise<T> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sxyprn ${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      pending = call();
      const value = await Promise.race([pending, deadline]);
      close();
      return value;
    } catch (error) {
      // Drain the abandoned call so a late rejection is not "unhandled".
      pending?.catch(() => {});
      trip(error as Error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  /**
   * Refuse calls while the break holds. Once the cooldown has elapsed exactly
   * one probe is admitted; a second concurrent caller still gets the break, so
   * a burst of scenes cannot become a burst of probes.
   */
  const guard = (): void => {
    if (!broken) return;
    if (Date.now() - openedAt < cooldownMs || probing) throw lastError;
    probing = true;
  };

  return {
    videos: {
      search: async (query: string): Promise<{ videos?: SxyprnCard[] }> => {
        guard();
        const page = await withDeadline(() => api.videos.search(query, { page: 0 }), "search");
        return {
          videos: (page.videos ?? []).map((video) => {
            const durationSeconds = durationSecondsOf(video);
            return {
              ...(video.url !== undefined ? { url: video.url } : {}),
              ...(video.title !== undefined ? { title: video.title } : {}),
              ...(durationSeconds !== null ? { durationSeconds } : {}),
              ...(video.isExternal !== undefined ? { isExternal: video.isExternal } : {}),
              ...(video.author !== undefined ? { author: video.author } : {}),
            };
          }),
        };
      },
      details: async (input: { url: string }): Promise<SxyprnDetail> => {
        guard();
        const detail = await withDeadline(() => api.videos.details({ url: input.url }), "details");
        const durationSeconds = durationSecondsOf(detail);
        return {
          ...(detail.url !== undefined ? { url: detail.url } : {}),
          ...(detail.title !== undefined ? { title: detail.title } : {}),
          ...(durationSeconds !== null ? { durationSeconds } : {}),
          ...(detail.streamUrl !== undefined ? { streamUrl: detail.streamUrl } : {}),
          // The two fields the detail pass exists for. Without them the post
          // carries no date, the date half of the gate cannot run, and the
          // sxyprn rung admits nothing.
          ...(detail.uploadDate !== undefined ? { uploadDate: detail.uploadDate } : {}),
          ...(detail.views !== undefined ? { views: detail.views } : {}),
          ...(detail.sizeBytes !== undefined ? { sizeBytes: detail.sizeBytes } : {}),
        };
      },
    },
  };
}

/**
 * Load the optional package. Returns null - never throws - when it is not
 * installed or does not expose the expected shape.
 */
export async function loadSxyprnClient(
  options: SxyprnClientOptions = {},
): Promise<SxyprnClient | null> {
  let module: { default?: unknown };
  try {
    module = (await import("sxyprn")) as { default?: unknown };
  } catch {
    return null;
  }
  const api = module.default as PackageApi | undefined;
  if (!api?.videos?.search || !api.videos.details) return null;
  return createSxyprnClient(api, options);
}