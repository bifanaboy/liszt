/**
 * Bang! Originals - the one direct-scrape lane with verified parsers, carried
 * over from `liszt-hands`.
 *
 * traxxx has no dedicated Bang! Originals channel, so the studio's own
 * `/studio/299/bang-originals` listing IS the authoritative catalogue. The
 * listing publishes a `SearchResultsPage` JSON-LD block plus a date on each
 * card; the per-video page publishes a `VideoObject`.
 *
 * Every parser throws on a missing required field. That is the whole reason
 * this lane is safe: a markup change must surface as a source error, never as
 * "Bang! released nothing this week" (which the retention rule would act on).
 */
import { createDirectScrapeStudio, decodeHtml, type ListingEntry } from "./direct-scrape.ts";
import type { RawScene } from "./types.ts";

const BASE_URL = "https://www.bang.com";
export const LISTING_URL = `${BASE_URL}/studio/299/bang-originals?by=date.desc&with=anal`;
export const BANG_ALLOWED_HOSTS = Object.freeze([new URL(BASE_URL).hostname]);

interface SearchResultsPage {
  "@type"?: string;
  mainEntity?: { itemListElement?: unknown[] };
}

/** Parse the listing's structured search results plus the card dates. */
export function parseListing(html: string, base: string): ListingEntry[] {
  const blocks = [
    ...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g),
  ];
  if (!blocks.length) {
    throw new Error("Bang! Originals listing is missing structured search results");
  }
  let data: SearchResultsPage | undefined;
  for (const [, block] of blocks) {
    try {
      const parsed = JSON.parse(block as string) as SearchResultsPage;
      if (parsed?.["@type"] === "SearchResultsPage") {
        data = parsed;
        break;
      }
    } catch {
      /* Keep looking for the structured search results block. */
    }
  }
  const items = data?.mainEntity?.itemListElement;
  if (data?.["@type"] !== "SearchResultsPage" || !Array.isArray(items)) {
    throw new Error("Bang! Originals listing has an unexpected structured response");
  }

  const datesByUrl = new Map<string, string>();
  for (const card of html.split('<div class="video_container').slice(1)) {
    const url = card.match(/href="([^"]*\/video\/[^"]+)"/)?.[1];
    const date = card.match(
      /<span class="mx-1 lg:mx-2">•<\/span>\s*([A-Za-z]{3} \d{1,2}, \d{4})/,
    )?.[1];
    if (url && date) {
      const parsed = new Date(`${date} UTC`);
      if (!Number.isNaN(parsed.getTime())) {
        datesByUrl.set(new URL(decodeHtml(url), base).href, parsed.toISOString().slice(0, 10));
      }
    }
  }
  if (!datesByUrl.size) {
    throw new Error("Bang! Originals listing carries no per-card dates");
  }

  return (items as { url?: unknown }[]).flatMap(({ url }) => {
    if (typeof url !== "string") return [];
    const absolute = new URL(url, base);
    if (absolute.origin !== base || !absolute.pathname.startsWith("/video/")) return [];
    const releaseDate = datesByUrl.get(absolute.href);
    return releaseDate ? [{ releaseUrl: absolute.href, releaseDate }] : [];
  });
}

interface BangVideoObject {
  "@type"?: string;
  name?: string;
  datePublished?: string;
  duration?: string;
  thumbnailUrl?: string;
  actor?: { name?: string }[];
}

/** Parse one video page's JSON-LD into a raw scene. Throws on anything missing. */
export function parseVideoPage(html: string, entry: ListingEntry): RawScene {
  const scripts = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  let video: BangVideoObject | undefined;
  for (const [, json] of scripts) {
    try {
      const parsed = JSON.parse(json as string) as BangVideoObject;
      if (parsed?.["@type"] === "VideoObject") {
        video = parsed;
        break;
      }
    } catch {
      /* Ignore unrelated malformed structured metadata. */
    }
  }
  const sourceSceneId = new URL(entry.releaseUrl).pathname.match(/^\/video\/([^/]+)/)?.[1];
  if (!video || !sourceSceneId || !video.name || !video.datePublished) {
    throw new Error(`Required Bang! video metadata missing for ${entry.releaseUrl}`);
  }
  const releaseDate = video.datePublished.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate) || Number.isNaN(Date.parse(`${releaseDate}T00:00:00Z`))) {
    throw new Error(`Invalid Bang! video release date for ${entry.releaseUrl}`);
  }
  const performers = Array.isArray(video.actor)
    ? [...new Set(video.actor.map(({ name }) => name?.trim()).filter((name): name is string => Boolean(name)))]
    : [];
  return {
    sourceSceneId,
    title: video.name.trim(),
    releaseDate,
    performers,
    durationSec: video.duration ? parseDuration(video.duration) : null,
    thumbnailUrl: typeof video.thumbnailUrl === "string" ? video.thumbnailUrl : "",
    releaseUrl: entry.releaseUrl,
    source: "Bang!",
    provenance: {
      source: "Bang!",
      sourceUrl: LISTING_URL,
      recordUrl: entry.releaseUrl,
      sourceSceneId,
    },
  };
}

function parseDuration(value: string): number | null {
  const iso = value.match(
    /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i,
  );
  if (!iso) {
    const clock = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
    if (!clock) return null;
    return Number(clock[1] || 0) * 3_600 + Number(clock[2]) * 60 + Number(clock[3]);
  }
  const total =
    Number(iso[1] || 0) * 86_400 + Number(iso[2] || 0) * 3_600 + Number(iso[3] || 0) * 60 + Number(iso[4] || 0);
  return total > 0 ? total : null;
}

export function createBangOriginalsStudio(): ReturnType<typeof createDirectScrapeStudio> {
  return createDirectScrapeStudio({
    id: "bang-originals",
    name: "Bang!",
    allowedHosts: BANG_ALLOWED_HOSTS,
    listingUrl: LISTING_URL,
    windowDays: 90,
    matcher: "sxyprn+eporner",
    role: "authoritative catalogue",
    parseListing,
    parseVideoPage: (html, entry) => parseVideoPage(html, entry),
  });
}
