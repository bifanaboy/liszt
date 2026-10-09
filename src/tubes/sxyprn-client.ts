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
 * sync. It also paces itself (see WHY THERE IS ONE SLOT below). Three wrappers
 * fix those, and all three are load-bearing:
 *
 *  - `withDeadline` caps one call at `timeoutMs` and drains the abandoned
 *    promise so a late rejection is not an unhandled rejection. The deadline is
 *    measured from the moment the call holds the request slot, so it bounds the
 *    REQUEST and not the queue in front of it.
 *  - One slot at a time. The package answers six requests a minute whatever we
 *    ask for, so concurrency buys no throughput and only moves each call further
 *    from the slot it was promised.
 *  - A shared circuit breaker stops the rung asking and the ladder moves on to
 *    eporner immediately rather than paying the deadline once per scene. It
 *    opens on EITHER `maxConsecutiveFailures` in a row OR a failing share of the
 *    last `failureWindow` calls, because the ladder's own concurrency defeats a
 *    consecutive-only rule (see WHY THE FAILING SHARE EXISTS below). The break
 *    is not permanent: after `cooldownMs` one half-open probe is allowed through, so
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
 * WHY THERE IS ONE SLOT, measured against the package at v0.1.0 (#23). The
 * package's `robots.txt` declares `Crawl-delay: 10`, so it keeps a
 * PROCESS-WIDE throttle: `reserveRequestSlot` hands every request a start time at
 * least `DEFAULT_MIN_REQUEST_INTERVAL_MS` (10s) after the previous one, and
 * `configureRequest` can only raise that interval, never lower it. The wait is
 * inside the call, before the request is issued. Measured here: the first search
 * answered in 176ms, the next three each took ~9.9s, and four concurrent searches
 * took 40.0s. The ladder fans out `fetchConcurrency` scenes (default 4) and a
 * scene's detail pass runs `detailConcurrency` posts at once, so with a 15s
 * deadline every call past the first was guaranteed to expire while merely
 * waiting its turn. Four in flight against a 10s floor loses about two of every
 * four, and that is the production shape: `errored: 110` of `attempted: 229`,
 * 48%, with no refusal, no network error and no parser break anywhere in the
 * log. Both counters cover every rung rather than this one alone (see
 * `RungRejections`), so 48% is a match to predict, not an attribution this
 * comment can make on its own - only a deployed run settles that. Serializing
 * costs nothing, because the package was never going to answer more than six
 * requests a minute; it only stops the ladder throwing away every call that had
 * not reached its slot yet.
 *
 * Everything the matcher gates on is forwarded verbatim - including `uploadDate`
 * and `views`, which are NOT decoration. `details()` is the only pass that
 * carries a real date, so dropping either field here silently made the sxyprn
 * rung unable to admit anything.
 *
 * WHY THE REQUESTS ARE COUNTED, measured by the slot itself (#71). `attempted`
 * and `errored` cover the whole ladder, so neither says how many requests this
 * rung spent, and the run's cost is exactly that number times the package's 10s
 * floor. The count is taken where the request is handed over, which is the one
 * place a request can be made - so a call refused by the break, and a search
 * answered from the lookup's cache, both cost nothing and count nothing, and any
 * budget added later is enforced at that same choke point rather than somewhere
 * the queue can go around.
 */
import type { SxyprnCard, SxyprnClient, SxyprnDetail, SxyprnRequestCount } from "./sxyprn.ts";

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

export interface PackageApi {
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
  // A non-finite window poisons both derived values: `Math.max(1, NaN)` stays
  // NaN, so `record()` never trims `outcomes` and never reaches the threshold.
  // Reject before normalizing.
  if (!Number.isFinite(failureWindow)) {
    throw new RangeError("failureWindow must be a finite number");
  }
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
  // The one request slot. See WHY THERE IS ONE SLOT: the package paces itself,
  // so a call that arrives early waits here rather than inside its own deadline.
  let queue: Promise<void> = Promise.resolve();
  // Requests handed to the package since the last `takeRequests()`. Counted
  // where the request is actually made, not where a call is refused or a search
  // is served from the lookup's cache, because those cost no floor and no time.
  const requests: SxyprnRequestCount = { search: 0, details: 0 };

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
  const withDeadline = async <T>(
    call: () => Promise<T>,
    label: keyof SxyprnRequestCount,
  ): Promise<T> => {
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
      // One request, counted as it is made. A request the deadline later abandons
      // was still spent - the package had it, and the floor ran - so an expired
      // call counts exactly like an answered one. That is what makes this number
      // the run's cost: requests x the pacing floor.
      requests[label] += 1;
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

  /** Whether the break is refusing calls right now, without claiming the probe. */
  const shut = (): boolean => broken && (Date.now() - openedAt < cooldownMs || probing);

  /**
   * Take the one request slot, wait for it, and only then start the deadline.
   *
   * The wait for the slot is the package's own politeness floor, not a hung
   * request, so charging it to `timeoutMs` is what turned a healthy source into
   * a wall of `timed out after 15000ms` (#23). It is also why the break is
   * checked twice: `shut()` refuses a caller immediately instead of parking it
   * behind a slot the source is no longer worth holding, and `guard()` runs once
   * the slot is in hand, which is where the single half-open probe is claimed.
   * A queued call therefore costs a wait, never a request it did not need.
   */
  const inSlot = async <T>(label: keyof SxyprnRequestCount, call: () => Promise<T>): Promise<T> => {
    if (shut()) throw openError();
    const ahead = queue;
    let release = (): void => {};
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await ahead;
    try {
      guard();
      return await withDeadline(call, label);
    } finally {
      release();
    }
  };

  return {
    videos: {
      search: async (query: string): Promise<{ videos?: SxyprnCard[] }> => {
        const page = await inSlot("search", () => api.videos.search(query, { page: 0 }));
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
        const detail = await inSlot("details", () => api.videos.details({ url: input.url }));
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
    takeRequests: (): SxyprnRequestCount => {
      const spent = { ...requests };
      requests.search = 0;
      requests.details = 0;
      return spent;
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
    // Resolve at runtime so Sxyprn remains optional for deployments that do
    // not want this provider or cannot reach its service.
    const packageName: string = "sxyprn";
    module = (await import(packageName)) as { default?: unknown };
  } catch {
    return null;
  }
  const api = module.default as PackageApi | undefined;
  if (!api?.videos?.search || !api.videos.details) return null;
  return createSxyprnClient(api, options);
}
