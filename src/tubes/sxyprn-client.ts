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
 *    eporner immediately rather than paying the deadline once per scene.
 */
import type { SxyprnCard, SxyprnClient, SxyprnDetail } from "./sxyprn.ts";

interface PackageVideoSummary {
  url?: string;
  title?: string;
  duration?: string;
  durationSeconds?: number;
  isExternal?: boolean;
  author?: unknown;
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
}

export function createSxyprnClient(
  api: PackageApi,
  options: SxyprnClientOptions = {},
): SxyprnClient {
  const { timeoutMs = 15_000, maxConsecutiveFailures = 2 } = options;
  let consecutiveFailures = 0;
  let broken = false;
  let lastError: Error = new Error("sxyprn unavailable");

  const withDeadline = async <T>(promise: Promise<T>, label: string): Promise<T> => {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sxyprn ${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      const value = await Promise.race([promise, deadline]);
      consecutiveFailures = 0;
      return value;
    } catch (error) {
      // Drain the abandoned call so a late rejection is not "unhandled".
      promise.catch(() => {});
      lastError = error as Error;
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxConsecutiveFailures) broken = true;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const guard = (): void => {
    if (broken) throw lastError;
  };

  return {
    videos: {
      search: async (query: string): Promise<{ videos?: SxyprnCard[] }> => {
        guard();
        const page = await withDeadline(api.videos.search(query, { page: 0 }), "search");
        return {
          videos: (page.videos ?? []).map((video) => ({
            ...(video.url !== undefined ? { url: video.url } : {}),
            ...(video.title !== undefined ? { title: video.title } : {}),
            ...(video.durationSeconds !== undefined
              ? { durationSeconds: video.durationSeconds }
              : {}),
            ...(video.isExternal !== undefined ? { isExternal: video.isExternal } : {}),
            ...(video.author !== undefined ? { author: video.author } : {}),
          })),
        };
      },
      details: async (input: { url: string }): Promise<SxyprnDetail> => {
        guard();
        const detail = await withDeadline(api.videos.details({ url: input.url }), "details");
        return {
          ...(detail.url !== undefined ? { url: detail.url } : {}),
          ...(detail.title !== undefined ? { title: detail.title } : {}),
          ...(detail.durationSeconds !== undefined
            ? { durationSeconds: detail.durationSeconds }
            : {}),
          ...(detail.streamUrl !== undefined ? { streamUrl: detail.streamUrl } : {}),
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