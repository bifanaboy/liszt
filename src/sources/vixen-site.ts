import { parseIsoDuration } from "./studio-site.ts";
import type { Fetcher, RawScene } from "./types.ts";

export const VIXEN_SITE_CODES: Readonly<Record<string, string>> = Object.freeze({
  "www.blacked.com": "BLACKED",
  "www.blackedraw.com": "BLACKEDRAW",
  "www.deeper.com": "DEEPER",
  "www.milfy.com": "MILFY",
  "www.tushy.com": "TUSHY",
  "www.tushyraw.com": "TUSHYRAW",
  "www.slayed.com": "SLAYED",
  "www.vixen.com": "VIXEN",
  "www.wifey.com": "WIFEY",
});

const VIDEO_QUERY = `query StudioVideo($videoSlug: String!, $site: Site!) {
  findOneVideo(input: { slug: $videoSlug, site: $site }) {
    slug
    title
    releaseDate
    runLength
    models { name }
    categories { name }
    images { poster { src width } }
  }
}`;

type VixenRecord = {
  slug?: unknown;
  title?: unknown;
  releaseDate?: unknown;
  runLength?: unknown;
  models?: unknown;
  categories?: unknown;
  images?: { poster?: unknown } | null;
};

function namedItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        if (!item || typeof item !== "object" || !("name" in item)) return [];
        const name = String((item as { name: unknown }).name ?? "").trim();
        return name ? [name] : [];
      }),
    ),
  ];
}

function thumbnail(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const images = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { src?: unknown; width?: unknown };
    const width = Number(record.width);
    return typeof record.src === "string" && record.src && Number.isFinite(width)
      ? [{ src: record.src, width }]
      : [];
  });
  return images.sort((a, b) => b.width - a.width)[0]?.src;
}

/** Parse only the record returned for the exact requested scene slug. */
export function parseVixenResponse(body: unknown, expectedSlug: string): Partial<RawScene> | null {
  if (!body || typeof body !== "object") return null;
  const record = (body as { data?: { findOneVideo?: VixenRecord | null } }).data?.findOneVideo;
  if (!record || typeof record !== "object" || record.slug !== expectedSlug) return null;

  const result: Partial<RawScene> = {};
  if (typeof record.title === "string" && record.title.trim()) result.title = record.title.trim();
  if (typeof record.releaseDate === "string") {
    const releaseDate = record.releaseDate.slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) result.releaseDate = releaseDate;
  }
  const durationSec = parseIsoDuration(record.runLength);
  if (durationSec) result.durationSec = durationSec;
  const performers = namedItems(record.models);
  if (performers.length) result.performers = performers;
  const tags = namedItems(record.categories);
  if (tags.length) result.tags = tags;
  const thumbnailUrl = thumbnail(record.images?.poster);
  if (thumbnailUrl) result.thumbnailUrl = thumbnailUrl;

  const fields = Object.keys(result) as Array<keyof RawScene>;
  if (!fields.length) return null;
  result.fieldProvenance = Object.fromEntries(fields.map((field) => [field, "studio-site"]));
  result.provenance = {
    source: "studio-site",
    sourceUrl: "https://www.vixen.com/graphql",
    sourceSceneId: expectedSlug,
  };
  return result;
}

function videoSlug(url: URL): string | null {
  const match = url.pathname.match(/^\/videos\/([a-z0-9-]+)\/?$/i);
  return match?.[1] ?? null;
}

/** Fetch metadata from the Vixen family detail API for one exact release URL. */
export async function scrapeVixenMetadata(
  releaseUrl: string,
  fetcher: Fetcher,
): Promise<Partial<RawScene> | null> {
  let url: URL;
  try {
    url = new URL(releaseUrl);
  } catch {
    return null;
  }
  const site = VIXEN_SITE_CODES[url.hostname.toLowerCase()];
  const slug = videoSlug(url);
  if (url.protocol !== "https:" || !site || !slug || url.username || url.password || url.port) {
    return null;
  }

  const response = await fetcher.fetch(`${url.origin}/graphql`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      referer: url.href,
    },
    body: JSON.stringify({ query: VIDEO_QUERY, variables: { site, videoSlug: slug } }),
  });
  if (!response.ok || response.status >= 300) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return parseVixenResponse(body, slug);
}
