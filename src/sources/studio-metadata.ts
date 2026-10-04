import { scrapeStudioSite, STUDIO_SITE_RECIPES } from "./studio-site.ts";
import { scrapeVixenMetadata, vixenSiteCodeFor } from "./vixen-site.ts";
import type { Fetcher, RawScene } from "./types.ts";

export { parseVixenResponse } from "./vixen-site.ts";

export interface StudioMetadataProfile {
  readonly kind: "vixen-graphql" | "studio-page";
  /**
   * The fields a complete lookup must supply. Per host, because a recipe only
   * promises the fields it can extract: demanding a duration from a host with no
   * duration extractor would re-fetch a fully read page every 24 hours and
   * spend the lookup budget on it forever.
   */
  readonly fields: readonly (keyof RawScene)[];
}

const VIXEN_PROFILE: StudioMetadataProfile = {
  kind: "vixen-graphql",
  fields: ["title", "releaseDate", "performers", "durationSec", "thumbnailUrl", "tags"],
};
const WOODMAN_PROFILE: StudioMetadataProfile = {
  kind: "studio-page",
  fields: ["title", "releaseDate", "performers", "thumbnailUrl", "tags"],
};

/** Recipe keys in the order a profile lists them. */
const FIELD_ORDER = [
  "title",
  "releaseDate",
  "performers",
  "durationSec",
  "thumbnailUrl",
  "tags",
] as const satisfies readonly (keyof RawScene)[];

const PAGE_PROFILES: Map<string, StudioMetadataProfile> = new Map();
for (const [host, recipe] of Object.entries(STUDIO_SITE_RECIPES)) {
  PAGE_PROFILES.set(
    host,
    /woodmancastingx\.com$/.test(host)
      ? WOODMAN_PROFILE
      : { kind: "studio-page", fields: recipeFields(recipe) },
  );
}

/** The scene fields a per-host recipe promises, in profile order. */
function recipeFields(recipe: (typeof STUDIO_SITE_RECIPES)[string]): (keyof RawScene)[] {
  const promised = {
    title: "title",
    releaseDate: "releaseDate",
    performers: "performers",
    durationSec: "duration",
    thumbnailUrl: "thumbnail",
    tags: "tags",
  } as const satisfies Partial<Record<keyof RawScene, string>>;
  return FIELD_ORDER.filter((field) =>
    Boolean(recipe[promised[field] as keyof (typeof STUDIO_SITE_RECIPES)[string]]),
  );
}

/** Return a scraper only for exact, reviewed HTTPS host profiles. */
export function getStudioMetadataProfile(value: string): StudioMetadataProfile | null {
  let url: URL;
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

/** List supported metadata fields with values other than null, undefined, or empty strings/arrays. */
function populatedFields(raw: Partial<RawScene>): (keyof RawScene)[] {
  return FIELD_ORDER.filter((field) => {
    const value = raw[field];
    return Array.isArray(value)
      ? value.length > 0
      : value !== undefined && value !== null && value !== "";
  });
}

/** A date-only value the scene schema accepts, or null. */
function calendarDate(value: string): string | null {
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : null;
}

/** Compare two release URLs the way a page's canonical link claims one. */
function sameRelease(left: string, right: string): boolean {
  const normalise = (value: string) => {
    try {
      const url = new URL(value);
      return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/$/, "").toLowerCase()}`;
    } catch {
      return value.toLowerCase();
    }
  };
  return normalise(left) === normalise(right);
}

/** Fill metadata from one known studio release page; unsupported URLs are never fetched. */
export async function scrapeReleaseMetadata(
  releaseUrl: string,
  fetcher: Fetcher,
): Promise<Partial<RawScene> | null> {
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
  const {
    metadataPoor: _metadataPoor,
    studioSiteStatus: _status,
    finalUrl,
    canonicalUrl,
    ...fields
  } = scraped;
  // The document has to be the release that was asked for. A page that says it
  // is a different release is rejected outright; a request that was redirected
  // away and carries no claim of its own is rejected too, because nothing left
  // ties it to the requested scene.
  if (canonicalUrl && !sameRelease(canonicalUrl, releaseUrl)) return null;
  if (!canonicalUrl && finalUrl && !sameRelease(finalUrl, releaseUrl)) return null;
  const result = fields as Partial<RawScene>;
  // A page's date is only usable if the schema would accept it; a malformed one
  // would fail the whole scene rather than fall back to the catalogue value.
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
