/**
 * Maximo Garcia - a direct-URL scrape, because traxxx's `mv.maximogarcia`
 * channel measured EMPTY in `liszt-hands` and the TPDB listing that used to
 * carry this lane is gone.
 *
 * STATUS: the listing is operator-configured. Neither reference repo recorded a
 * Maximo Garcia listing URL or a verified parser for it, so this adapter
 * ships with a generic JSON-LD listing/page parser and a `LISZT_MAXIMO_LISTING_URL`
 * variable. Unset, the lane reports "not configured" - a calm, named status the
 * dashboard renders as SETUP REQUIRED - rather than silently emitting nothing
 * and letting the retention rule wipe the lane.
 *
 * To enable it, set `LISZT_MAXIMO_LISTING_URL` to a studio listing page that
 * publishes JSON-LD (`ItemList`/`CollectionPage` with `VideoObject` items, or
 * per-card links with dates) and whose video pages publish a `VideoObject`.
 * Everything else - the walk, the window gate, the loud shape-change failure -
 * is shared with the Bang! lane in `direct-scrape.ts`.
 */
import { createDirectScrapeStudio, type ListingEntry } from "./direct-scrape.ts";
import { extractStudioMetadata, STUDIO_SITE_RECIPES } from "./studio-site.ts";
import type { RawScene } from "./types.ts";

const VIDEO_TYPES = new Set(["videoobject", "mediaobject", "movie", "tvepisode", "clip"]);

function isVideo(type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((entry) => VIDEO_TYPES.has(String(entry || "").toLowerCase()));
}

function collectJsonLd(html: string): unknown[] {
  const out: unknown[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      out.push(JSON.parse((match[1] as string).trim()));
    } catch {
      /* A malformed block is skipped; a page with no usable block throws below. */
    }
  }
  return out;
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) {
    if (child && typeof child === "object") walk(child, visit);
  }
}

function itemUrl(entry: Record<string, unknown>, base: string): string | undefined {
  const candidates = [entry.url, entry["@id"], (entry.item as Record<string, unknown>)?.url];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || !candidate) continue;
    try {
      return new URL(candidate, base).href;
    } catch {
      /* Try the next shape. */
    }
  }
  return undefined;
}

function itemDate(entry: Record<string, unknown>): string | undefined {
  const item = (entry.item ?? {}) as Record<string, unknown>;
  for (const value of [entry.datePublished, item.datePublished, item.uploadDate]) {
    if (typeof value === "string") {
      const match = value.match(/^\d{4}-\d{2}-\d{2}/);
      if (match) return match[0];
    }
  }
  return undefined;
}

/**
 * A generic JSON-LD listing parser: any `VideoObject` reachable from a
 * `ListItem` or an `itemListElement`, dated. Throws when it finds no dated
 * video entries, because an undated listing cannot bound the per-page fan-out
 * and silently hydrating an entire archive would be far worse than failing.
 */
export function parseJsonLdListing(html: string, base: string): ListingEntry[] {
  const blocks = collectJsonLd(html);
  if (!blocks.length) {
    throw new Error("Maximo Garcia listing carries no JSON-LD blocks");
  }
  const found = new Map<string, ListingEntry>();
  let sawVideoEntry = false;
  for (const block of blocks) {
    walk(block, (record) => {
      const listItem = String(record["@type"] ?? "");
      if (!/listitem|listentry/i.test(listItem)) return;
      const item = (record.item ?? record) as Record<string, unknown>;
      if (!isVideo(item["@type"]) && !/listitem|listentry/i.test(listItem)) return;
      sawVideoEntry = true;
      const url = itemUrl(record, base);
      const date = itemDate(record);
      if (url && date) found.set(url, { releaseUrl: url, releaseDate: date });
    });
  }
  if (!found.size) {
    throw new Error(
      sawVideoEntry
        ? "Maximo Garcia listing found video entries but no dates; refusing to hydrate an unbounded archive"
        : "Maximo Garcia listing has no dated JSON-LD video entries",
    );
  }
  return [...found.values()];
}

function durationSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value);
  const text = String(value ?? "").trim();
  const clock = text.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.\d+)?$/);
  if (clock) return Number(clock[1] || 0) * 3_600 + Number(clock[2]) * 60 + Number(clock[3]);
  const iso = text.match(/^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (iso) {
    const total =
      Number(iso[1] || 0) * 86_400 +
      Number(iso[2] || 0) * 3_600 +
      Number(iso[3] || 0) * 60 +
      Number(iso[4] || 0);
    return total > 0 ? total : null;
  }
  return null;
}

/**
 * Parse one video page: the page's own `VideoObject` first, then the shared
 * studio-site recipe for the allowlisted hosts, then `<meta>`. Throws when the
 * page yields no title or no date, so a shape change is a loud failure.
 */
export function parseMaximoVideoPage(html: string, entry: ListingEntry): RawScene {
  let video: Record<string, unknown> | undefined;
  for (const block of collectJsonLd(html)) {
    walk(block, (record) => {
      if (!video && isVideo(record["@type"])) video = record;
    });
  }
  const site = extractStudioMetadata(html, entry.releaseUrl);
  const hostname = new URL(entry.releaseUrl).hostname.toLowerCase();
  const recipeProvenance = hostname in STUDIO_SITE_RECIPES ? "studio-site" : undefined;

  const title = String(video?.name ?? entry.title ?? site.title ?? "").trim();
  const releaseDate = String(
    video?.datePublished ?? video?.uploadDate ?? entry.releaseDate ?? "",
  ).slice(0, 10);
  if (!title) throw new Error(`Maximo Garcia video page has no title: ${entry.releaseUrl}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) {
    throw new Error(`Maximo Garcia video page has no usable release date: ${entry.releaseUrl}`);
  }

  const actors = video?.actor ?? video?.actors;
  const performers = [
    ...new Set(
      (Array.isArray(actors) ? actors : actors ? [actors] : [])
        .map((actor: unknown) =>
          typeof actor === "string"
            ? actor.trim()
            : String((actor as { name?: unknown })?.name ?? "").trim(),
        )
        .filter(Boolean),
    ),
  ];
  const listed = (site.performers ?? []).filter((name) => !performers.includes(name));
  const merged = [...new Set([...performers, ...listed])];

  const durationSec = durationSeconds(video?.duration) ?? site.durationSec ?? null;
  const fieldProvenance: Record<string, string> = {};
  if (video?.duration || site.durationSec) {
    fieldProvenance.durationSec = video?.duration ? "json-ld" : (recipeProvenance ?? "meta");
  }
  if (merged.length) {
    fieldProvenance.performers = performers.length ? "json-ld" : (recipeProvenance ?? "meta");
  }
  if (!performers.length && !listed.length) fieldProvenance.performers = "unavailable";

  // Identity is the FULL origin plus path, not the path alone. Two Maximo
  // mirror hosts carry the same path structure, so a pathname-only key let a
  // record from one host overwrite the other in the store - last host walked
  // won, and the other mirror's record was lost with no trace.
  const sceneId = maximoSceneId(entry.releaseUrl);

  return {
    sourceSceneId: sceneId,
    title,
    releaseDate,
    performers: merged,
    durationSec,
    thumbnailUrl:
      (typeof video?.thumbnailUrl === "string" && video.thumbnailUrl) || site.thumbnailUrl || "",
    releaseUrl: entry.releaseUrl,
    source: "Maximo Garcia",
    fieldProvenance,
    metadataPoor: !durationSec || !merged.length,
    provenance: {
      source: "Maximo Garcia",
      sourceUrl: entry.releaseUrl,
      recordUrl: entry.releaseUrl,
      sourceSceneId: sceneId,
    },
  };
}

/** `<host>/<path>`, the store key for one Maximo Garcia release page. */
export function maximoSceneId(releaseUrl: string): string {
  const url = new URL(releaseUrl);
  return `${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * Build the lane. `listingUrl` is undefined unless `LISZT_MAXIMO_LISTING_URL` is
 * set, in which case the adapter reports "not configured" until it is.
 */
export function createMaximoGarciaStudio(
  listingUrl: string | undefined,
  allowedHosts: readonly string[],
): ReturnType<typeof createDirectScrapeStudio> {
  return createDirectScrapeStudio({
    id: "maximo-garcia",
    name: "Maximo Garcia",
    allowedHosts,
    listingUrl,
    windowDays: 90,
    matcher: "sxyprn+eporner",
    // A creator studio: performer-only queries return better recall than the
    // studio name, which is shared with hundreds of other releases.
    creatorStudio: true,
    role: "direct scrape",
    configVariable: "LISZT_MAXIMO_LISTING_URL",
    parseListing: parseJsonLdListing,
    parseVideoPage: (html, entry) => parseMaximoVideoPage(html, entry),
  });
}
