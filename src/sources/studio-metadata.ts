import { scrapeStudioSite, STUDIO_SITE_RECIPES } from "./studio-site.ts";
import { scrapeVixenMetadata, VIXEN_SITE_CODES } from "./vixen-site.ts";
import type { Fetcher, RawScene } from "./types.ts";

export { parseVixenResponse } from "./vixen-site.ts";

export interface StudioMetadataProfile {
  readonly kind: "vixen-graphql" | "studio-page";
  readonly fields: readonly (keyof RawScene)[];
}

const VIXEN_PROFILE: StudioMetadataProfile = {
  kind: "vixen-graphql",
  fields: ["title", "releaseDate", "performers", "durationSec", "thumbnailUrl", "tags"],
};
const PAGE_PROFILE: StudioMetadataProfile = {
  kind: "studio-page",
  fields: ["title", "releaseDate", "performers", "durationSec", "thumbnailUrl"],
};

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
  if (VIXEN_SITE_CODES[host] && /^\/videos\/[a-z0-9-]+\/?$/i.test(url.pathname)) {
    return VIXEN_PROFILE;
  }
  if (host in STUDIO_SITE_RECIPES) return PAGE_PROFILE;
  return null;
}

function populatedFields(raw: Partial<RawScene>): (keyof RawScene)[] {
  return (["title", "releaseDate", "performers", "durationSec", "thumbnailUrl", "tags"] as const)
    .filter((field) => {
      const value = raw[field];
      return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== "";
    });
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
  const { metadataPoor: _metadataPoor, studioSiteStatus: _status, ...fields } = scraped;
  const result = fields as Partial<RawScene>;
  if (!populatedFields(result).length) return null;
  result.provenance = {
    source: "studio-site",
    sourceUrl: releaseUrl,
    recordUrl: releaseUrl,
  };
  return result;
}
