/** Eporner's public search and video record API. */
import type { Fetcher } from "../sources/types.ts";
import { pickMatch, type IdentityTier, type TubeCandidate } from "../core/matching.ts";
import { buildQueries } from "./queries.ts";
import type { MatchScene } from "./types.ts";

const VIDEO_URL = "https://www.eporner.com/api/v2/video/id/";
const SEARCH_URL = "https://www.eporner.com/api/v2/video/search/";
export const EPORNER_HOSTS = Object.freeze(["eporner.com", "www.eporner.com"]);

export interface EpornerVideo {
  id?: string;
  title?: string;
  url?: string;
  embed?: string;
  length_sec?: number | string;
  /** The upload timestamp. Null when the API row carries none. */
  added?: string | null;
  /**
   * View count. Null when the source reported none.
   *
   * Distinct from `undefined` and from 0 for the same reason `added` is: the
   * ranking chain lets a candidate with a KNOWN count outrank one the source
   * said nothing about, and falls through to lag when both are unknown. A
   * fabricated 0 would let an uncounted video outrank a genuinely uncounted one.
   */
  views?: number | string | null;
  uploader?: string;
}

/** `35:38` -> 2138, `1:23:45` -> 5025. */
export function parseClockDuration(value: string | null | undefined): number | null {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  const [, first, second, third] = match as unknown as [string, string, string, string | undefined];
  const seconds =
    third === undefined
      ? Number(first) * 60 + Number(second)
      : Number(first) * 3600 + Number(second) * 60 + Number(third);
  return seconds > 0 ? seconds : null;
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
    if (
      url.protocol !== "https:" ||
      !EPORNER_HOSTS.includes(url.hostname) ||
      (url.port && url.port !== "443")
    )
      return false;
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
      (!url.port || url.port === "443") &&
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

function toCandidate(video: EpornerVideo): TubeCandidate {
  return {
    url: String(video.url ?? ""),
    title: String(video.title ?? ""),
    duration: Number(video.length_sec),
    added: video.added ?? null,
    views: video.views ?? null,
    ...(video.uploader ? { uploader: video.uploader } : {}),
  };
}

export interface EpornerOpenMatch {
  video: EpornerVideo;
  candidate: TubeCandidate;
  identityTier: IdentityTier;
}

export interface EpornerSearchOptions {
  fetcher: Fetcher;
  perPage?: number;
  cacheTtlMs?: number;
}

export function buildEpornerSearchUrl(query: string, perPage = 100): string {
  const url = new URL(SEARCH_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", "1");
  url.searchParams.set("order", "latest");
  url.searchParams.set("format", "json");
  url.searchParams.set("lq", "0");
  return url.href;
}

export function createEpornerOpenSearch({
  fetcher,
  perPage = 100,
  cacheTtlMs = 5 * 60_000,
}: EpornerSearchOptions): (query: string) => Promise<EpornerVideo[]> {
  const cached = createExpiringCache({ ttlMs: cacheTtlMs });
  return (query) =>
    cached(query, async () => {
      const data = await fetcher.json<{ videos?: unknown }>(buildEpornerSearchUrl(query, perPage), {
        headers: { accept: "application/json" },
      });
      if (!data || !Array.isArray(data.videos))
        throw new Error("eporner returned an invalid response");
      return data.videos as EpornerVideo[];
    });
}

export function createEpornerOpenLookup(
  search: (query: string) => Promise<EpornerVideo[]>,
  gate: { durationToleranceSec?: number; dateWindowDays: number },
): (scene: MatchScene) => Promise<EpornerOpenMatch[]> {
  return async (scene) => {
    const queries = buildQueries(scene);
    const results = await Promise.allSettled(queries.map(search));
    const successful = results.filter(
      (result): result is PromiseFulfilledResult<EpornerVideo[]> => result.status === "fulfilled",
    );
    if (!successful.length) throw new Error("eporner search unavailable");
    const videos = [
      ...new Map(
        successful.flatMap(({ value }) => value).map((video) => [String(video.url ?? ""), video]),
      ).values(),
    ];
    const matches: EpornerOpenMatch[] = [];
    for (const video of videos) {
      if (!validEpornerUrl(video.url) || !validEpornerEmbedUrl(video.embed)) continue;
      const candidate = toCandidate(video);
      const match = pickMatch(scene, [candidate], { ...gate, requireIdentity: false });
      if (match) matches.push({ video, candidate, identityTier: match.identityTier });
    }
    return matches;
  };
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
