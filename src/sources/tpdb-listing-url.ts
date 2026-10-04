/**
 * Parse a ThePornDB listing address into a lane spec, mirroring
 * parseTraxxxListingUrl's validation style and error messages.
 *
 * A listing address is the URL a person copies from TPDB after filtering,
 * e.g.
 *   https://theporndb.net/scenes?orderBy=most_relevant&page=1&site=bang&site_id=988
 *   &tag_and=0&tags%5B70%5D=Anal
 *
 * Returns { siteId, siteSlug, tags, id, url }.
 * Validation rejects: non-HTTPS, wrong host, missing/non-numeric/zero site_id,
 * empty tag set, and any unrecognised query parameter.
 * Unknown parameters are an error (not silently ignored), matching
 * parseTraxxxListingUrl's behaviour.
 */
import type { TpdbStudio } from "./tpdb-watchlist.ts";

const TPDB_LISTING_HOSTS: readonly string[] = Object.freeze(["theporndb.net", "www.theporndb.net"]);

/** Read tag names from `tags[N]=Name` parameters, discarding the bracket index N. */
function readListingTags(url: URL): string[] {
  const names = new Set<string>();
  for (const [key, value] of url.searchParams) {
    // Only accept the exact bracket form tags[N] where N is digits (possibly empty).
    // Reject tags[] (empty brackets) - the issue spec says an empty tag set is rejected.
    if (!/^tags\[\d+\]$/.test(key)) continue;
    const name = value.trim();
    if (!name) {
      throw new Error(
        `Invalid TPDB listing URL: ${key} has no tag name (expected a name like "Anal")`,
      );
    }
    if (!/^[a-zA-Z0-9]+/.test(name)) {
      throw new Error(
        `Invalid TPDB listing URL: ${key}=${JSON.stringify(name)} has no letters or digits to match on`,
      );
    }
    names.add(name);
  }
  // Case-insensitively de-duplicated, then ordered deterministically.
  const folded = new Map<string, string>();
  for (const name of names) {
    const key = name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    if (key && !folded.has(key)) folded.set(key, name);
  }
  // Sort by cleaned name for deterministic order.
  return [...folded.values()].sort((a, b) =>
    a
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .localeCompare(b.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")),
  );
}

/** Read the site_id from the URL, or throw if missing/invalid. */
function readSiteId(url: URL): number {
  const value = url.searchParams.get("site_id");
  if (value === null) {
    throw new Error(`Invalid TPDB listing URL: missing site_id (a lane needs a site to narrow to)`);
  }
  if (!/^\d+$/.test(value) || Number(value) <= 0) {
    throw new Error(`Invalid TPDB listing URL: site_id must be a positive integer`);
  }
  const id = Number(value);
  if (!Number.isSafeInteger(id)) {
    throw new Error(`Invalid TPDB listing URL: site_id is greater than MAX_SAFE_INTEGER`);
  }
  return id;
}

/** Read the `site` query parameter value (the slug hint), lowercased. */
function readSiteSlug(url: URL): string | undefined {
  const raw = url.searchParams.get("site");
  if (raw == null) return undefined; // handles both null and undefined
  return raw.trim().toLowerCase();
}

/** Validate that every query parameter is recognised.
 *  Unknown parameters are rejected (not silently ignored), matching
 *  parseTraxxxListingUrl's behaviour.
 */
function validateKnownParams(url: URL): void {
  const known = new Set(["site_id", "site", "tag_and", "tags", "page", "orderBy", "per_page"]);
  for (const key of url.searchParams.keys()) {
    if (!known.has(key)) {
      throw new Error(`Invalid TPDB listing URL: unrecognised query parameter \`${key}\``);
    }
  }
}

/** Parse a ThePornDB listing address into a lane spec.
 *
 * Returns { siteId, siteSlug, tags, id, url }.
 * - siteId: the numeric site id (authoritative)
 * - siteSlug: the `site=` value lowercased, for display
 * - tags: cleaned, de-duplicated tag names (discarding bracket index N)
 * - id: deterministic lane id in Traxxx style: `[siteId, ...tags].join("-")`
 * - url: the normalised, validated URL string
 *
 * Rejection rules (all throw):
 *  1. Non-HTTPS protocol
 *  2. Host other than `theporndb.net` or `www.theporndb.net`
 *  3. Missing, non-numeric, or zero site_id
 *  4. Empty tag set (no `tags[N]=Name` parameters)
 *  5. Unrecognised query parameter (error, not ignored)
 */
export interface TpdbLaneSpec {
  siteId: number;
  siteSlug: string | undefined;
  tags: readonly string[];
  id: string;
  url: string;
}

export function parseTpdbListingUrl(raw: string): TpdbLaneSpec {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid TPDB listing URL ${raw}: not a URL`);
  }

  // 1. HTTPS only
  if (url.protocol !== "https:") {
    throw new Error(`Invalid TPDB listing URL ${raw}: must use HTTPS`);
  }

  // 2. Host restricted to TPDB hosts
  if (!TPDB_LISTING_HOSTS.includes(url.hostname)) {
    throw new Error(`Invalid TPDB listing URL ${raw}: unsupported host ${url.hostname}`);
  }

  // 3. Validate known query parameters (unknown = error)
  validateKnownParams(url);

  // 4. Read site_id (required)
  const siteId = readSiteId(url);

  // 5. Read site slug hint (optional, for display)
  const siteSlug = readSiteSlug(url);

  // 6. Read tag names (required - empty set rejected)
  const tags = readListingTags(url);
  if (tags.length === 0) {
    throw new Error(
      `Invalid TPDB listing URL: no tag filter present (a lane with no tags would enrol the whole site)`,
    );
  }

  // 7. Deterministic lane id (Traxxx style)
  const idParts = [String(siteId), ...tags].map((p) =>
    p
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase(),
  );
  const id = idParts.join("-");

  return {
    siteId,
    siteSlug,
    tags, // already readonly string[]
    id,
    url: raw.trim(),
  };
}

/** Create TpdbStudio declarations from a list of parsed listing URLs.
 *  Each address becomes a studio with its resolved siteId and parsed tags.
 */
export function tpdbListingUrlsToStudios(urls: readonly string[]): readonly TpdbStudio[] {
  return urls.map((raw) => {
    const spec = parseTpdbListingUrl(raw);
    const tagList = spec.tags;
    // Build studioId: tpdb-<siteId>~<tagKey> or tpdb-<siteId>
    const tagKey = tagList.length
      ? tagList
          .map((t) =>
            t
              .normalize("NFKD")
              .replace(/[\u0300-\u036f]/g, "")
              .toLowerCase(),
          )
          .join("-")
      : "";
    const studioId = `tpdb-${spec.siteId}${tagKey ? `~${tagKey}` : ""}`;

    // Build studio name from site slug
    const slug = spec.siteSlug ?? "";
    const studioName = slug
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part[0]!.toUpperCase() + part.slice(1))
      .join(" ");

    // Build aliases from studio name and tag names
    const aliases: string[] = [studioName];
    if (tagList.length) {
      tagList.forEach((tag) => {
        aliases.push(tag);
      });
    }

    return {
      studioId,
      studio: studioName,
      aliases,
      tags: tagList.length ? tagList : undefined,
      siteId: spec.siteId,
    };
  });
}
