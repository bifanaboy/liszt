/**
 * The studio-site metadata scraper.
 *
 * A catalogue index is a cache, not the source of truth: when it lacks a field,
 * the scene's own release URL carries it (sexlikereal and analvids embed
 * ISO-8601 durations and performer lists in page metadata). JSON-LD is tried
 * first, then the per-host recipe, then `<meta>` tags.
 *
 * Extraction is SSRF-safe: an allowlist of studio hosts, private/reserved
 * addresses rejected, and EVERY redirect re-validated so a page cannot bounce
 * the fetcher at an internal address.
 *
 * Every field this module supplies is recorded in `field_provenance`, so the
 * dashboard can name where a duration actually came from.
 */
import type { Fetcher } from "./types.ts";

export const STUDIO_SITE_RECIPES: Readonly<
  Record<
    string,
    {
      duration?: RegExp;
      performers?: RegExp;
      title?: RegExp;
      releaseDate?: RegExp;
      thumbnail?: RegExp;
      tags?: RegExp;
    }
  >
> = Object.freeze({
  "sexlikereal.com": { duration: /["']duration["']\s*:\s*["']([^"']+)["']/i },
  "analvids.com": {
    duration: /(?:duration|runtime)[^>]{0,120}(?:content=["']([^"']+)|>\s*([^<]+))/i,
    performers: /(?:starring|performers?|models?)[^>]*>\s*([^<]+)/i,
  },
  "pissvids.com": {
    duration: /(?:duration|runtime)[^>]{0,120}(?:content=["']([^"']+)|>\s*([^<]+))/i,
    performers: /(?:starring|performers?|models?)[^>]*>\s*([^<]+)/i,
  },
  "bustyworld.com": {
    title: /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    releaseDate: /<i\b[^>]*bi-calendar3[^>]*>[\s\S]*?<\/i>\s*([^<]+)/i,
    performers: /<h1\b[^>]*class=["'][^"']*watch__title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i,
    thumbnail: /<video\b[^>]*data-poster=["']([^"']+)/i,
  },
  "woodmancastingx.com": {
    title: /<h1\b[^>]*>([\s\S]*?)<\/h1>/i,
    releaseDate: /<p\b[^>]*>\s*<span[^>]*>Published<\/span>[^\d]*(\d{4}-\d{2}-\d{2})/i,
    performers: /<span\b[^>]*class=["']name["'][^>]*>([\s\S]*?)<\/span>/gi,
    thumbnail: /image:\s*["']([^"']+)["']/i,
    tags: /<a\b[^>]*class=["']tag["'][^>]*>([\s\S]*?)<\/a>/gi,
  },
});

/** Hosts are keyed bare; a leading `www.` is normalised away before lookup. */
const ALLOWED_HOSTS = new Set(Object.keys(STUDIO_SITE_RECIPES));
/** Lowercase, `www.`-stripped host for recipe lookup. */
export function bareHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}
const MAX_REDIRECTS = 10;

/** True for loopback, private, link-local, multicast, or reserved hosts. */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (match) {
    const [a, b] = match.slice(1).map(Number) as [number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
  }
  if (host === "localhost" || host === "localhost.localdomain") return true;
  if (
    host === "::1" ||
    host.startsWith("fe80:") ||
    host.startsWith("fc") ||
    host.startsWith("fd")
  ) {
    return true;
  }
  return false;
}

/**
 * Validate a URL against the host allowlist and the reservation checks.
 *
 * The same policy covers the requested URL and every redirect hop, so a
 * redirect cannot move the request to another port on an approved host or
 * attach credentials to it.
 */
export function isUrlAllowed(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (url.username || url.password || url.port) return false;
  const hostname = bareHost(url.hostname);
  if (isPrivateOrReservedHost(hostname)) return false;
  return ALLOWED_HOSTS.has(hostname);
}

export function parseIsoDuration(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  const text = String(value ?? "").trim();
  const iso = text.match(
    /^P(?:(\d+(?:\.\d+)?)D)?T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/i,
  );
  if (iso) {
    const seconds =
      Number(iso[1] || 0) * 86_400 +
      Number(iso[2] || 0) * 3_600 +
      Number(iso[3] || 0) * 60 +
      Number(iso[4] || 0);
    return seconds > 0 ? Math.round(seconds) : null;
  }
  const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (clock) {
    const total = Number(clock[1] || 0) * 3_600 + Number(clock[2]) * 60 + Number(clock[3]);
    return total > 0 ? total : null;
  }
  const hours = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i)?.[1] || 0);
  const minutes = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|m)\b/i)?.[1] || 0);
  const seconds = Number(text.match(/(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i)?.[1] || 0);
  const total = hours * 3_600 + minutes * 60 + seconds;
  return total > 0 ? Math.round(total) : null;
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

function names(value: unknown): string[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      list
        .flatMap((item) => {
          if (typeof item === "string") return item.split(/,|\s+(?:and|&)\s+/i);
          return item && typeof item === "object" && "name" in item
            ? [String((item as { name: unknown }).name)]
            : [];
        })
        .map(cleanText)
        .filter(Boolean),
    ),
  ];
}

const VIDEO_LD_TYPES = new Set(["videoobject", "mediaobject", "movie", "tvepisode", "clip"]);

function isVideoEntity(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => VIDEO_LD_TYPES.has(String(entry || "").toLowerCase()));
}

export interface ExtractedStudioMetadata {
  durationSec: number | null;
  releaseDate: string;
  performers: string[];
  title: string;
  thumbnailUrl: string;
  tags: string[];
}

function visit(value: unknown, output: ExtractedStudioMetadata): void {
  if (Array.isArray(value)) {
    for (const item of value) visit(item, output);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (isVideoEntity(record["@type"])) {
    if (output.durationSec === null && record.duration) {
      output.durationSec = parseIsoDuration(record.duration);
    }
    if (!output.releaseDate) {
      output.releaseDate = String(
        record.datePublished ?? record.uploadDate ?? record.releaseDate ?? "",
      );
    }
    if (!output.performers.length) {
      output.performers = names(
        record.actor ?? record.actors ?? record.performer ?? record.performers ?? record.author,
      );
    }
    if (!output.title && record.name) output.title = cleanText(record.name);
    if (!output.thumbnailUrl && typeof record.thumbnailUrl === "string") {
      output.thumbnailUrl = record.thumbnailUrl;
    }
  }
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") visit(child, output);
  }
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([:\w-]+)\s*=\s*(["'])(.*?)\2/gs)) {
    result[(match[1] as string).toLowerCase()] = cleanText(match[3]);
  }
  return result;
}

/**
 * Extract title, duration, release date, performers, and thumbnail from a studio
 * page: JSON-LD first, then `<meta>`, then the per-host recipe.
 */
export function extractStudioMetadata(
  html: string,
  releaseUrl = "",
): Partial<ExtractedStudioMetadata> {
  const output: ExtractedStudioMetadata = {
    durationSec: null,
    releaseDate: "",
    performers: [],
    title: "",
    thumbnailUrl: "",
    tags: [],
  };
  for (const match of String(html).matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      visit(JSON.parse((match[1] as string).trim()), output);
    } catch {
      /* Ignore a malformed block and try the remaining metadata. */
    }
  }
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    const value = attrs.content || attrs.value;
    if (!value) continue;
    if (output.durationSec === null && /duration/.test(key)) {
      output.durationSec = parseIsoDuration(value);
    }
    if (
      !output.releaseDate &&
      /(?:datepublished|release_date|published_time|uploaddate)/.test(key)
    ) {
      output.releaseDate = value;
    }
    if (!output.performers.length && /(?:actor|performer|starring)/.test(key)) {
      output.performers = names(value);
    }
    if (!output.title && /^(?:og:)?title$/.test(key)) output.title = cleanText(value);
    if (!output.thumbnailUrl && /^(?:og:)?image$/.test(key)) output.thumbnailUrl = value;
  }

  let hostname = "";
  try {
    hostname = bareHost(new URL(releaseUrl).hostname);
  } catch {
    /* An unsupported URL simply has no host recipe. */
  }
  const recipe = STUDIO_SITE_RECIPES[hostname];
  const text = (value: string | undefined) => cleanText(value?.replace(/<[^>]*>/g, " "));
  if (recipe?.duration && output.durationSec === null) {
    const match = String(html).match(recipe.duration);
    output.durationSec = parseIsoDuration(match?.[1] ?? match?.[2]);
  }
  if (recipe?.performers && !output.performers.length) {
    const match = String(html).match(recipe.performers);
    const performerMatches = recipe.performers.global
      ? [...String(html).matchAll(recipe.performers)].map((item) => item[1])
      : [match?.[1] ?? match?.[2]];
    // A performer captured out of markup may be a nested link, and its anchor
    // text is the name: `<a href="...">Jane Doe</a>` is not a usable name.
    output.performers = names(performerMatches.map(text));
  }
  if (recipe?.title && !output.title) output.title = text(String(html).match(recipe.title)?.[1]);
  if (recipe?.releaseDate && !output.releaseDate) {
    output.releaseDate = text(String(html).match(recipe.releaseDate)?.[1]);
  }
  if (recipe?.thumbnail && !output.thumbnailUrl) {
    output.thumbnailUrl = String(html).match(recipe.thumbnail)?.[1] ?? "";
  }
  if (recipe?.tags) {
    output.tags = [...String(html).matchAll(recipe.tags)]
      .map((item) => text(item[1]))
      .filter(Boolean);
  }
  if (output.releaseDate) output.releaseDate = output.releaseDate.slice(0, 10);
  return Object.fromEntries(
    Object.entries(output).filter(
      ([, value]) => value !== "" && value !== null && (!Array.isArray(value) || value.length),
    ),
  ) as Partial<ExtractedStudioMetadata>;
}

/**
 * The page's own claim about which release it shows: `<link rel="canonical">`,
 * then `og:url`. Empty when the page makes no such claim.
 */
export function extractCanonicalUrl(html: string): string {
  const canonical = String(html).match(
    /<link\b[^>]*rel=["'][^"']*canonical[^"']*["'][^>]*>/gi,
  )?.[0];
  const linkHref = canonical ? attributes(canonical).href : undefined;
  if (linkHref) return linkHref.trim();
  for (const match of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if ((attrs.property || "").toLowerCase() === "og:url" && attrs.content) {
      return attrs.content.trim();
    }
  }
  return "";
}

export interface ScrapedMetadata {
  durationSec?: number;
  releaseDate?: string;
  performers?: string[];
  title?: string;
  thumbnailUrl?: string;
  tags?: string[];
  metadataPoor: boolean;
  studioSiteStatus?: number;
  fieldProvenance?: Record<string, string>;
  /** The URL the request finally landed on, after any redirects. */
  finalUrl?: string;
  /** The page's own canonical or `og:url` claim, or empty. */
  canonicalUrl?: string;
}

/** Fetch one allowed studio page, following redirects only while they stay allowed. */
export async function scrapeStudioSite(
  releaseUrl: string | undefined,
  { fetcher, userAgent }: { fetcher: Fetcher; userAgent?: string },
): Promise<ScrapedMetadata> {
  if (!releaseUrl) return { metadataPoor: true };
  let url: URL;
  try {
    url = new URL(releaseUrl);
  } catch {
    return { metadataPoor: true };
  }
  if (!isUrlAllowed(url)) return { metadataPoor: true };

  let currentUrl = url;
  let finalResponse: Response | null = null;
  for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await fetcher.fetch(currentUrl.href, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          ...(userAgent ? { "user-agent": userAgent } : {}),
        },
      });
    } catch {
      return { metadataPoor: true };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) break;
      try {
        const next = new URL(location, currentUrl);
        // Re-validate every hop: a redirect is attacker-influenced input.
        if (!isUrlAllowed(next)) return { metadataPoor: true };
        currentUrl = next;
        continue;
      } catch {
        return { metadataPoor: true };
      }
    }
    finalResponse = response;
    break;
  }
  if (!finalResponse || !finalResponse.ok) {
    return finalResponse
      ? { metadataPoor: true, studioSiteStatus: finalResponse.status }
      : { metadataPoor: true };
  }
  const html = await finalResponse.text();
  const metadata = extractStudioMetadata(html, currentUrl.href);
  if (!Object.keys(metadata).length) return { metadataPoor: true };
  return {
    ...metadata,
    metadataPoor: false,
    fieldProvenance: Object.fromEntries(
      Object.keys(metadata).map((field) => [field, "studio-site"]),
    ),
    finalUrl: currentUrl.href,
    canonicalUrl: extractCanonicalUrl(html),
  } as ScrapedMetadata;
}

/** True when a field the gate needs is missing. */
export function metadataIncomplete(scene: {
  durationSec?: number | null;
  releaseDate?: string;
  performers?: string[];
}): boolean {
  return (
    !scene.durationSec ||
    !scene.releaseDate ||
    !Array.isArray(scene.performers) ||
    scene.performers.length === 0
  );
}
