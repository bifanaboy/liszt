/**
 * The eporner primitives the trusted-pool rung is built from: URL shapes, id
 * extraction, and the per-video record fetch.
 *
 * THE OPEN-SEARCH CLIENT IS GONE. It was rung 3 of the ladder and it has been
 * deleted, with the rung, because it could not answer the question the ladder
 * asks it. The v2 search API takes `query, per_page, page, thumbsize, order,
 * gay, lq, format` and NO upload date, so a scene released 90 days ago could
 * only be reached by paginating backwards from `order=latest` with no reliable
 * stop - and the uploader appears in no API response at all, only in the video
 * page markup, so the rung could not tell a trusted repost from an untrusted
 * account's upload. It contributed one link out of 46, and that link came from
 * an account outside the trusted pool, so removing it cost that uploader's
 * whole catalogue rather than one link.
 *
 * The two behaviours that client was written to enforce go with it, and the
 * reasoning is kept here because it applies to anything that talks to this API
 * later: the API DEFAULTS to `lq=1`, which INCLUDES low-quality content (both
 * reference repos omitted `lq` and silently ingested it), and there is no
 * resolution field at all - only `length_sec`, `views`, `embed`, and a
 * `default_thumb` whose dimensions are the requested thumb size rather than the
 * native resolution - so a numeric quality floor is not possible without
 * scraping the embed page.
 */
import type { Fetcher } from "../sources/types.ts";

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
