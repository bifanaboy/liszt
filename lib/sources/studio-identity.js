import { z } from "../validation.js";
import { FetchError } from "../fetcher.js";
export const TPDB_BASE = "https://api.theporndb.net";
export const TPDB_WEB_HOSTS = Object.freeze(["theporndb.net", "www.theporndb.net"]);
export const TRAXXX_WEB_HOSTS = Object.freeze(["traxxx.me", "www.traxxx.me"]);
const TpdbSite = z.object({
  id: z.number().int().positive(),
  uuid: z.string().uuid().optional(),
  name: z.string().min(1),
  short_name: z.string().min(1).nullable().optional(),
  url: z.string().url().nullable().optional(),
  network_id: z.number().int().positive().nullable().optional(),
});
const TpdbSiteEnvelope = z.object({ data: TpdbSite });
const TpdbSitePage = z.object({
  data: z.array(TpdbSite),
  meta: z.object({ total: z.number().int().nonnegative() }).optional(),
});
export function cleanStudioName(value) {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
export function studioNameKeys(site) {
  return [site.name, site.short_name ?? ""].map(cleanStudioName).filter(Boolean);
}
export function parseTpdbStudioUrl(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid TPDB studio URL ${raw}: not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`Invalid TPDB studio URL ${raw}: must use HTTPS`);
  if (!TPDB_WEB_HOSTS.includes(url.hostname)) {
    throw new Error(`Invalid TPDB studio URL ${raw}: unsupported host ${url.hostname}`);
  }
  const tags = readSearchTags(url, raw);
  const tagsField = tags.length ? { tags } : {};
  const nameHint = url.searchParams.get("name") ?? undefined;
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        throw new Error(`Invalid TPDB studio URL ${raw}: malformed path encoding`);
      }
    });
  const uuidParam = url.searchParams.get("uuid");
  if (uuidParam !== null && !z.string().uuid().safeParse(uuidParam).success) {
    throw new Error(`Invalid TPDB studio URL ${raw}: uuid is not a UUID`);
  }
  const uuid = uuidParam ?? segments.find((s) => z.string().uuid().safeParse(s).success);
  if (uuid) {
    return { candidates: [uuid], uuid, ...tagsField, ...(nameHint ? { name: nameHint } : {}) };
  }
  const siteId = readSiteId(url, raw);
  if (siteId !== undefined) {
    const slugHint = url.searchParams.get("site") ?? undefined;
    const name = nameHint ?? (slugHint ? displayNameFromSlug(slugHint) : undefined);
    return {
      candidates: [String(siteId)],
      exactSiteId: siteId,
      ...tagsField,
      ...(name ? { name } : {}),
    };
  }
  const last = segments.at(-1);
  const identifier = last ? (/^\d+$/.test(last) ? last : cleanStudioName(last)) : "";
  if (!identifier) {
    throw new Error(`Invalid TPDB studio URL ${raw}: no studio identifier in the path`);
  }
  if (isContainerSegment(last)) {
    throw new Error(
      `Invalid TPDB studio URL ${raw}: a ${identifier} search needs a site_id query parameter`,
    );
  }
  return { candidates: [identifier], ...tagsField, ...(nameHint ? { name: nameHint } : {}) };
}
const CONTAINER_SEGMENTS = new Set(
  ["scenes", "studios", "tags", "studios-scenes", "search", "categories"].map(cleanStudioName),
);
function isContainerSegment(segment) {
  return segment !== undefined && CONTAINER_SEGMENTS.has(cleanStudioName(segment));
}
function readSearchTags(url, raw) {
  const names = new Set();
  for (const [key, value] of url.searchParams) {
    if (!/^tags\[\d*\]$/.test(key)) continue;
    const name = value.trim();
    if (!name) {
      throw new Error(
        `Invalid TPDB studio URL ${raw}: ${key} has no tag name (expected a name like "Anal")`,
      );
    }
    if (!cleanStudioName(name)) {
      throw new Error(
        `Invalid TPDB studio URL ${raw}: ${key}=${JSON.stringify(name)} has no letters or digits to match on`,
      );
    }
    names.add(name);
  }
  const folded = new Map();
  for (const name of names) {
    const key = cleanStudioName(name);
    if (key && !folded.has(key)) folded.set(key, name);
  }
  const tagAnd = url.searchParams.get("tag_and");
  const allOf = tagAnd !== null && ["1", "true", "and"].includes(tagAnd.trim().toLowerCase());
  if (folded.size > 1 && !allOf) {
    const seen = tagAnd === null ? "no tag_and" : `tag_and=${tagAnd}`;
    throw new Error(
      `Invalid TPDB studio URL ${raw}: ${seen} with ${folded.size} tags cannot be one lane`,
    );
  }
  return [...folded.values()].sort((a, b) => cleanStudioName(a).localeCompare(cleanStudioName(b)));
}
function readSiteId(url, raw) {
  const value = url.searchParams.get("site_id");
  if (value === null) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`Invalid TPDB studio URL ${raw}: site_id must be a positive integer`);
  }
  return Number(value);
}
function displayNameFromSlug(slug) {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
function siteSatisfies(site, lookup) {
  if (lookup.uuid) return site.uuid === lookup.uuid;
  if (lookup.exactSiteId !== undefined) return site.id === lookup.exactSiteId;
  const wanted = cleanStudioName(lookup.name ?? "");
  if (!wanted) return false;
  return studioNameKeys(site).includes(wanted);
}
async function getSite(fetcher, token, identifier) {
  const url = new URL(`/sites/${encodeURIComponent(identifier)}`, TPDB_BASE).href;
  const raw = await fetcher.json(url, { headers: { Authorization: `Bearer ${token}` } });
  return TpdbSiteEnvelope.parse(raw).data;
}
export async function resolveTpdbSite(fetcher, token, lookup) {
  const wanted = cleanStudioName(lookup.name ?? "");
  let sawDefinitiveMiss = false;
  for (const candidate of lookup.candidates) {
    let site;
    try {
      site = await getSite(fetcher, token, candidate);
    } catch (error) {
      if (error instanceof FetchError && error.kind === "definitive") {
        sawDefinitiveMiss = true;
        continue;
      }
      throw error;
    }
    if (!siteSatisfies(site, lookup)) continue;
    return {
      site: {
        siteId: site.id,
        uuid: site.uuid,
        name: site.name,
        shortName: site.short_name ?? undefined,
        url: site.url ?? undefined,
        networkId: site.network_id ?? undefined,
        resolvedBy: /^[0-9a-f-]{36}$/i.test(candidate)
          ? "uuid"
          : /^\d+$/.test(candidate)
            ? "id"
            : "slug",
      },
      outcome: "resolved",
      candidates: [],
    };
  }
  if (lookup.exactSiteId !== undefined) {
    return { site: undefined, outcome: "absent", candidates: [] };
  }
  const search = await searchSites(fetcher, token, lookup.name ?? wanted);
  if (search === undefined) {
    if (sawDefinitiveMiss) return { site: undefined, outcome: "absent", candidates: [] };
    throw new Error("TPDB studio search did not answer");
  }
  const exact = search.filter((site) => Boolean(wanted) && studioNameKeys(site).includes(wanted));
  if (exact.length === 1 && exact[0]) {
    const site = exact[0];
    return {
      site: {
        siteId: site.id,
        uuid: site.uuid,
        name: site.name,
        shortName: site.short_name ?? undefined,
        url: site.url ?? undefined,
        networkId: site.network_id ?? undefined,
        resolvedBy: "search",
      },
      outcome: "resolved",
      candidates: [],
    };
  }
  return {
    site: undefined,
    outcome: exact.length > 1 ? "ambiguous" : "absent",
    candidates: search
      .slice(0, 10)
      .map((site) => ({ id: site.id, name: site.name, shortName: site.short_name ?? undefined })),
  };
}
async function searchSites(fetcher, token, query) {
  const term = query.trim();
  if (!term) return [];
  const url = new URL("/sites", TPDB_BASE);
  url.searchParams.set("q", term);
  url.searchParams.set("per_page", "25");
  try {
    const raw = await fetcher.json(url.href, { headers: { Authorization: `Bearer ${token}` } });
    return TpdbSitePage.parse(raw).data;
  } catch (error) {
    if (error instanceof FetchError && error.kind === "definitive") return [];
    return undefined;
  }
}
export const StudioLinkSchema = z.object({
  studioId: z.string().min(1),
  studio: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  traxxx: z
    .object({
      kind: z.enum(["network", "channel"]),
      slug: z.string().regex(/^[a-z0-9-]+$/),
      url: z.string().url(),
    })
    .optional(),
  tpdb: z
    .object({
      siteIds: z.array(z.number().int().positive()).min(1),
      uuid: z.string().uuid().optional(),
      name: z.string().min(1),
      shortName: z.string().min(1).optional(),
      url: z.string().url().optional(),
      networkId: z.number().int().positive().optional(),
    })
    .optional(),
});
export function canonicalStudioId(link) {
  if (link.traxxx) {
    return [link.traxxx.kind, link.traxxx.slug, ...(link.tags ?? [])].join("-");
  }
  const key = cleanStudioName(link.tpdb?.shortName ?? link.tpdb?.name ?? "studio");
  return `tpdb-${key.replace(/ /g, "-")}`;
}
export function studioAliases(link) {
  return [...new Set([link.studio, ...(link.aliases ?? [])].map(cleanStudioName).filter(Boolean))];
}
export function auditStudioLinks(links) {
  const problems = [];
  const byKey = new Map();
  const bySite = new Map();
  const byAlias = new Map();
  for (const link of links) {
    byKey.set(link.studioId, [...(byKey.get(link.studioId) ?? []), link.studio]);
    if (link.tpdb)
      for (const siteId of link.tpdb.siteIds)
        bySite.set(siteId, [...(bySite.get(siteId) ?? []), link.studioId]);
    for (const alias of studioAliases(link)) {
      byAlias.set(alias, (byAlias.get(alias) ?? new Set()).add(link.studioId));
    }
  }
  for (const [key, studios] of byKey) {
    if (studios.length > 1)
      problems.push(`duplicate studioId "${key}" claimed by ${studios.join(", ")}`);
  }
  for (const [siteId, ids] of bySite) {
    if (ids.length > 1) problems.push(`TPDB site ${siteId} is claimed by ${ids.join(", ")}`);
  }
  for (const [alias, ids] of [...byAlias].sort(([a], [b]) => a.localeCompare(b))) {
    if (ids.size > 1) {
      problems.push(
        `alias "${alias}" is claimed by ${[...ids].sort().join(", ")}; neither would resolve in TPDB`,
      );
    }
  }
  return problems;
}
