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
 *  - A shared circuit breaker stops the rung asking and the ladder moves on to
 *    eporner immediately rather than paying the deadline once per scene. It
 *    opens on EITHER `maxConsecutiveFailures` in a row OR a failing share of the
 *    last `failureWindow` calls, because the ladder's own concurrency defeats a
 *    consecutive-only rule (see WHY THE FAILING SHARE EXISTS below). The break is
 *    not permanent: after `cooldownMs` one half-open probe is allowed through, so
 *    a source that recovers (a blocked IP is a transient condition, not a
 *    permanent one) rejoins the ladder without a restart.
 *
 *  WHY THE FAILING SHARE EXISTS, measured from the production log this issue
 *  was filed against. The rung timed out on 110 of 229 scenes in one run while
 *  the break sat closed the whole time. `resolveLinks` fans out
 *  `fetchConcurrency` scenes and each scene searches several queries in turn, so
 *  calls from different scenes interleave: a source failing every second request
 *  never produces two failures IN A ROW, and a counter that only ever resets on
 *  success can therefore never reach its threshold. Every scene kept paying the
 *  full 15 s deadline, which is the unbounded cost the break existed to prevent.
 *  Counting the share of a window rather than the run closes that hole, and the
 *  consecutive rule stays as the fast path for a source that is simply down.
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
  /** How many recent call outcomes the failing share is measured over. */
  failureWindow?: number;
  /** Failing share of that window that opens the break. */
  failureRatio?: number;
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
  const {
    timeoutMs = 15_000,
    maxConsecutiveFailures = 2,
    failureWindow = 10,
    failureRatio = 0.5,
    cooldownMs = 10 * 60_000,
  } = options;
  const windowSize = Math.max(1, Math.floor(failureWindow));
  // A non-finite share makes every comparison against `minFailures` false, which
  // silently leaves only the consecutive-failure rule alive - the interleaved
  // pattern this window exists to catch. Clamping is the worse answer: it would
  // turn a share above 1 into "open on any failure", so reject instead.
  if (!Number.isFinite(failureRatio)) {
    throw new RangeError("failureRatio must be a finite number");
  }
  const minFailures = Math.max(1, Math.ceil(windowSize * failureRatio));
  let consecutiveFailures = 0;
  let broken = false;
  let openedAt = 0;
  let probing = false;
  let lastError: Error = new Error("sxyprn unavailable");
  // Oldest first, capped at `windowSize`. `true` is a call the source answered.
  // Kept across the break so a source that keeps answering badly cannot buy
  // another full round of deadlines by failing one call between two successes.
  const outcomes: boolean[] = [];

  const failures = (): number => outcomes.reduce((total, ok) => total + (ok ? 0 : 1), 0);

  /** Record one outcome and report whether the window now says "too broken". */
  const record = (ok: boolean): boolean => {
    outcomes.push(ok);
    if (outcomes.length > windowSize) outcomes.shift();
    return outcomes.length >= windowSize && failures() >= minFailures;
  };

  /**
   * The break is only ever lifted by the probe that was let through it, or by
   * nothing: an ordinary success cannot reach here while the break holds, and
   * `guard()` refuses first.
   */
  const clear = (): void => {
    consecutiveFailures = 0;
    broken = false;
    probing = false;
    openedAt = 0;
    outcomes.length = 0;
  };

  /**
   * What a refused call reports. Deliberately NOT the original failure: while
   * the break holds the app is spending no request, and repeating a live
   * timeout is what made the log look like the rung was still trying.
   */
  const openError = (): Error =>
    new Error(
      `sxyprn circuit open (${failures()} of ${outcomes.length} recent calls failed); last: ${lastError.message}`,
    );

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
    const unhealthy = record(false);
    if (consecutiveFailures >= maxConsecutiveFailures || unhealthy) {
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
      // Only the probe's success wipes the slate. An ordinary success resets the
      // consecutive counter - so "two in a row" keeps its meaning across a long
      // healthy run - and adds itself to the window, which is what lets the
      // window drain back towards healthy as the source recovers.
      if (probing) clear();
      else {
        consecutiveFailures = 0;
        record(true);
      }
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
    if (Date.now() - openedAt < cooldownMs || probing) throw openError();
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
              ...(video.views !== undefined ? { views: video.views } : {}),
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
