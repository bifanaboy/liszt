import { parseIsoDuration } from "./studio-site.js";
const VIXEN_CODES = Object.freeze({
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
const VIXEN_SITE_CODES = new Map(Object.entries(VIXEN_CODES));
export function vixenSiteCodeFor(hostname) {
  return VIXEN_SITE_CODES.get(hostname.toLowerCase()) ?? null;
}
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
function namedItems(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        if (!item || typeof item !== "object" || !("name" in item)) return [];
        const name = String(item.name ?? "").trim();
        return name ? [name] : [];
      }),
    ),
  ];
}
function thumbnail(value) {
  if (!Array.isArray(value)) return undefined;
  const images = value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item;
    const width = Number(record.width);
    return typeof record.src === "string" && record.src && Number.isFinite(width)
      ? [{ src: record.src, width }]
      : [];
  });
  return images.sort((a, b) => b.width - a.width)[0]?.src;
}
export function parseVixenResponse(body, expectedSlug) {
  if (!body || typeof body !== "object") return null;
  const record = body.data?.findOneVideo;
  if (!record || typeof record !== "object" || record.slug !== expectedSlug) return null;
  const result = {};
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
  const fields = Object.keys(result);
  if (!fields.length) return null;
  result.fieldProvenance = Object.fromEntries(fields.map((field) => [field, "studio-site"]));
  result.provenance = {
    source: "studio-site",
    sourceUrl: "https://www.vixen.com/graphql",
    sourceSceneId: expectedSlug,
  };
  return result;
}
function videoSlug(url) {
  const match = url.pathname.match(/^\/videos\/([a-z0-9-]+)\/?$/i);
  return match?.[1] ?? null;
}
export async function scrapeVixenMetadata(releaseUrl, fetcher) {
  let url;
  try {
    url = new URL(releaseUrl);
  } catch {
    return null;
  }
  const site = vixenSiteCodeFor(url.hostname);
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
  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  return parseVixenResponse(body, slug);
}
