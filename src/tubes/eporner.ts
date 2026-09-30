/**
 * eporner open search - rung 3 of the ladder. Real REST API, no key, and a
 * `length_sec` on every row.
 *
 * THE `lq` PARAMETER. The API DEFAULTS TO `lq=1`, which *includes*
 * low-quality content. Both reference repos omitted `lq` entirely and so
 * silently ingested it. It is now always passed explicitly, and
 * `test/eporner.test.ts` asserts the request URL carries it - that assertion is
 * the only thing keeping the bug from coming back.
 *
 * There is no resolution field in the v2 REST API (only `length_sec`, `views`,
 * `embed`, and a `default_thumb` whose dimensions are the requested thumb size,
 * not the native video resolution), so a numeric quality floor is not possible
 * without scraping the embed page. `lq=0` is the accepted approximation.
 */
import { pickMatch, type IdentityTier, type TubeCandidate } from "../core/matching.ts";
import { buildQueries } from "./queries.ts";
import type { Fetcher } from "../sources/types.ts";
import type { MatchScene } from "./types.ts";

const SEARCH_URL = "https://www.eporner.com/api/v2/video/search/";
const VIDEO_URL = "https://www.eporner.com/api/v2/video/id/";
export const EPORNER_HOSTS = Object.freeze(["eporner.com", "www.eporner.com"]);

export interface EpornerVideo {
  id?: string;
  title?: string;
  url?: string;
  embed?: string;
  length_sec?: number | string;
  /** The upload timestamp. Null when the API row carries none. */
  added?: string | null;
  views?: number | string;
  uploader?: string;
}

/** The canonical eporner watch URL for a video id. */
export function epornerWatchUrl(id: string): string {
  return `https://www.eporner.com/video-${id}/`;
}

export function epornerEmbedUrl(id: string): string {
  return `https://www.eporner.com/embed/${id}/`;
}

export function validEpornerUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || !EPORNER_HOSTS.includes(url.hostname)) return false;
    if (url.username || url.password || url.search || url.hash) return false;
    // Search rows use `/video-<id>/...`; the id lookup answers `/hd-porn/<id>/...`.
    return /^\/(?:video-[A-Za-z0-9]+|hd-porn\/[A-Za-z0-9]+)(?:\/[^/]*)?\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

export function validEpornerEmbedUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      EPORNER_HOSTS.includes(url.hostname) &&
      /^\/embed\/[A-Za-z0-9]+\/?$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** Extract the eporner video id from any accepted URL shape. */
export function epornerVideoId(value: unknown): string | null {
  try {
    const pathname = new URL(String(value)).pathname;
    return (
      pathname.match(/^\/video-([A-Za-z0-9]+)/)?.[1] ??
      pathname.match(/^\/hd-porn\/([A-Za-z0-9]+)/)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

/** Map an API row to the shared candidate shape. */
export function toCandidate(video: EpornerVideo): TubeCandidate {
  return {
    url: String(video.url ?? ""),
    title: String(video.title ?? ""),
    duration: Number(video.length_sec),
    added: video.added ?? null,
    views: video.views ?? null,
    ...(video.uploader ? { uploader: video.uploader } : {}),
  };
}

/**
 * Gate eporner rows against a scene. The same rule as every other rung: the
 * duration band and the upload window filter, identity only ranks.
 *
 * `added` comes free on every search row - measured live, 200 of 200 rows
 * carried a parseable one - so this rung adds zero requests for the date half.
 * The accepted candidate is returned, not the row, so callers can record which
 * shape actually passed.
 */
export function matchEpornerOpen(
  scene: MatchScene,
  videos: EpornerVideo[],
  options: { durationToleranceSec?: number; dateWindowDays: number },
): { video: EpornerVideo; candidate: TubeCandidate; identityTier: IdentityTier } | null {
  const safe = videos
    .filter((video) => validEpornerUrl(video.url) && validEpornerEmbedUrl(video.embed))
    .map(toCandidate);
  const match = pickMatch(scene, safe, options);
  if (!match) return null;
  const video = videos.find((entry) => String(entry.url ?? "") === match.candidate.url);
  return video ? { video, candidate: match.candidate, identityTier: match.identityTier } : null;
}

/** Deduplicate concurrent lookups for a short window; evict rejections at once. */
export function createExpiringCache({ ttlMs = 5 * 60_000, limit = 512 } = {}) {
  const entries = new Map<string, { createdAt: number; value: Promise<unknown> }>();
  return function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = entries.get(key);
    if (entry && now - entry.createdAt < ttlMs) return entry.value as Promise<T>;
    entries.delete(key);
    const value = Promise.resolve().then(load);
    entries.set(key, { createdAt: now, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    if (entries.size > limit) entries.delete(entries.keys().next().value as string);
    return value;
  };
}

export interface EpornerSearchOptions {
  fetcher: Fetcher;
  /** 0 excludes low-quality content. The API default of 1 INCLUDES it. */
  lq?: number;
  perPage?: number;
  /** Set false to skip the one-per-run search cache (used in tests). */
  cacheTtlMs?: number;
}

/**
 * The open-search request URL. Exported so the `lq=0` assertion in the tests
 * reads the same code path the client uses, rather than a re-implementation.
 */
export function buildSearchUrl(
  query: string,
  { lq, perPage = 1000 }: { lq: number; perPage?: number },
): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", "1");
  url.searchParams.set("order", "latest");
  url.searchParams.set("format", "json");
  // Explicit, and never defaulted. This is the inherited bug this fixes.
  url.searchParams.set("lq", String(lq));
  return url.href;
}

export function createEpornerOpenSearch({
  fetcher,
  lq = 0,
  perPage = 1000,
  cacheTtlMs = 5 * 60_000,
}: EpornerSearchOptions): (query: string) => Promise<EpornerVideo[]> {
  const cached = createExpiringCache({ ttlMs: cacheTtlMs });
  return (query: string) =>
    cached(query, async () => {
      const data = await fetcher.json<{ videos?: unknown }>(
        buildSearchUrl(query, { lq, perPage }),
        {
          headers: { accept: "application/json" },
        },
      );
      if (!data || !Array.isArray(data.videos)) {
        throw new Error("eporner returned an invalid response");
      }
      return data.videos as EpornerVideo[];
    });
}

/** The eporner-open winner, with the tier that admitted it. */
export interface EpornerOpenMatch {
  video: EpornerVideo;
  identityTier: IdentityTier;
}

/**
 * Build the open-search lookup bound to one scene. Throws only when the source
 * itself could not answer every query, so the caller can distinguish an outage
 * from a clean no-match.
 */
export function createEpornerOpenLookup(
  search: (query: string) => Promise<EpornerVideo[]>,
  gate: { durationToleranceSec?: number; dateWindowDays: number },
): (scene: MatchScene) => Promise<EpornerOpenMatch[]> {
  return async (scene: MatchScene): Promise<EpornerOpenMatch[]> => {
    if (!Number.isFinite(scene.durationSec)) return [];
    const queries = buildQueries(scene);
    const results = await Promise.allSettled(queries.map(search));
    const successful = results.filter(
      (result): result is PromiseFulfilledResult<EpornerVideo[]> => result.status === "fulfilled",
    );
    if (!successful.length) throw new Error("eporner open search unavailable");
    const videos = [
      ...new Map(
        successful.flatMap(({ value }) => value).map((video) => [String(video.url ?? ""), video]),
      ).values(),
    ];
    const match = matchEpornerOpen(scene, videos, gate);
    return match ? [{ video: match.video, identityTier: match.identityTier }] : [];
  };
}

/** Fetch one video's record. An empty array is a definitive "no such id". */
export function createEpornerVideoLookup(fetcher: Fetcher) {
  return async (id: string): Promise<EpornerVideo | null> => {
    const url = new URL(VIDEO_URL);
    url.searchParams.set("id", id);
    url.searchParams.set("format", "json");
    const data = await fetcher.json<unknown>(url.href, { headers: { accept: "application/json" } });
    if (Array.isArray(data)) return data.length ? (data[0] as EpornerVideo) : null;
    if (data && typeof data === "object" && (data as EpornerVideo).id) return data as EpornerVideo;
    return null;
  };
}
