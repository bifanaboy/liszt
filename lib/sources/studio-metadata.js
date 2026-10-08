import { scrapeStudioSite, STUDIO_SITE_RECIPES } from "./studio-site.js";
import { parseVixenResponse, scrapeVixenMetadata, vixenSiteCodeFor } from "./vixen-site.js";
export { parseVixenResponse };
const VIXEN_PROFILE = {
  kind: "vixen-graphql",
  fields: ["title", "releaseDate", "performers", "durationSec", "thumbnailUrl", "tags"],
};
const WOODMAN_PROFILE = {
  kind: "studio-page",
  fields: ["title", "releaseDate", "performers", "thumbnailUrl", "tags"],
};
const FIELD_ORDER = ["title", "releaseDate", "performers", "durationSec", "thumbnailUrl", "tags"];
const PAGE_PROFILES = new Map();
for (const [host, recipe] of Object.entries(STUDIO_SITE_RECIPES)) {
  PAGE_PROFILES.set(
    host,
    /woodmancastingx\.com$/.test(host)
      ? WOODMAN_PROFILE
      : { kind: "studio-page", fields: recipeFields(recipe) },
  );
}
function recipeFields(recipe) {
  const promised = {
    title: "title",
    releaseDate: "releaseDate",
    performers: "performers",
    durationSec: "duration",
    thumbnailUrl: "thumbnail",
    tags: "tags",
  };
  return FIELD_ORDER.filter((field) => Boolean(recipe[promised[field]]));
}
export function getStudioMetadataProfile(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  if (vixenSiteCodeFor(host) && /^\/videos\/[a-z0-9-]+\/?$/i.test(url.pathname)) {
    return VIXEN_PROFILE;
  }
  return PAGE_PROFILES.get(host) ?? null;
}
function populatedFields(raw) {
  return FIELD_ORDER.filter((field) => {
    const value = raw[field];
    return Array.isArray(value)
      ? value.length > 0
      : value !== undefined && value !== null && value !== "";
  });
}
function calendarDate(value) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : null;
}
function sameRelease(left, right) {
  const normalise = (value) => {
    try {
      const url = new URL(value);
      return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "").toLowerCase()}`;
    } catch {
      return value.toLowerCase();
    }
  };
  return normalise(left) === normalise(right);
}
export async function scrapeReleaseMetadata(releaseUrl, fetcher) {
  const profile = getStudioMetadataProfile(releaseUrl);
  if (!profile) return null;
  if (profile.kind === "vixen-graphql") {
    const result = await scrapeVixenMetadata(releaseUrl, fetcher);
    if (result?.provenance) {
      result.provenance.sourceUrl = `${new URL(releaseUrl).origin}/graphql`;
      result.provenance.recordUrl = releaseUrl;
    }
    return result;
  }
  const scraped = await scrapeStudioSite(releaseUrl, { fetcher });
  const fields = { ...scraped };
  delete fields.metadataPoor;
  delete fields.studioSiteStatus;
  const { finalUrl, canonicalUrl } = fields;
  delete fields.finalUrl;
  delete fields.canonicalUrl;
  if (canonicalUrl && !sameRelease(canonicalUrl, releaseUrl)) return null;
  if (!canonicalUrl && finalUrl && !sameRelease(finalUrl, releaseUrl)) return null;
  const result = fields;
  const releaseDate = result.releaseDate ? calendarDate(result.releaseDate) : null;
  if (!releaseDate) delete result.releaseDate;
  if (!populatedFields(result).length) return null;
  result.provenance = {
    source: "studio-site",
    sourceUrl: releaseUrl,
    recordUrl: releaseUrl,
  };
  return result;
}
