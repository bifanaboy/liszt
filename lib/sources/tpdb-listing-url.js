const TPDB_LISTING_HOSTS = Object.freeze(["theporndb.net", "www.theporndb.net"]);
function readListingTags(url) {
  const names = new Set();
  for (const [key, value] of url.searchParams) {
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
  const folded = new Map();
  for (const name of names) {
    const key = name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    if (key && !folded.has(key)) folded.set(key, name);
  }
  return [...folded.values()].sort((a, b) =>
    a
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .localeCompare(b.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")),
  );
}
function readSiteId(url) {
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
function readSiteSlug(url) {
  const raw = url.searchParams.get("site");
  if (raw == null) return undefined;
  return raw.trim().toLowerCase();
}
function validateKnownParams(url) {
  const known = new Set(["site_id", "site", "tag_and", "tags", "page", "orderBy", "per_page"]);
  for (const key of url.searchParams.keys()) {
    if (!known.has(key)) {
      throw new Error(`Invalid TPDB listing URL: unrecognised query parameter \`${key}\``);
    }
  }
}
export function parseTpdbListingUrl(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid TPDB listing URL ${raw}: not a URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Invalid TPDB listing URL ${raw}: must use HTTPS`);
  }
  if (!TPDB_LISTING_HOSTS.includes(url.hostname)) {
    throw new Error(`Invalid TPDB listing URL ${raw}: unsupported host ${url.hostname}`);
  }
  validateKnownParams(url);
  const siteId = readSiteId(url);
  const siteSlug = readSiteSlug(url);
  const tags = readListingTags(url);
  if (tags.length === 0) {
    throw new Error(
      `Invalid TPDB listing URL: no tag filter present (a lane with no tags would enrol the whole site)`,
    );
  }
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
    tags,
    id,
    url: raw.trim(),
  };
}
export function tpdbListingUrlsToStudios(urls) {
  return urls.map((raw) => {
    const spec = parseTpdbListingUrl(raw);
    const tagList = spec.tags;
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
    const slug = spec.siteSlug ?? "";
    const studioName = slug
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part[0].toUpperCase() + part.slice(1))
      .join(" ");
    const aliases = [studioName];
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
      siteIds: [spec.siteId],
    };
  });
}
