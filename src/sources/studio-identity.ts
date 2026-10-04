/**
 * One canonical studio, and the rules for linking its two outside identities.
 *
 * Liszt's watchlist is written as URLs - one Traxxx listing per studio, and
 * ThePornDB (TPDB) as the studio's own site page. Those two databases name the
 * same studio differently and neither name is stable enough to be the key:
 * TPDB renames sites, Traxxx slugs do not always match the site's display name,
 * and a bare cleaned-name comparison silently collides on every studio whose
 * names are prefixes of one another (Brazzers / Brazzers Vault / Brazzers
 * Live).
 *
 * So the studio is the unit, and the URLs are how it is *declared*:
 *
 *   - `studioId` is Liszt's own key. When a studio has a Traxxx lane it is the
 *     existing lane id, so no stored scene or label changes meaning. A
 *     TPDB-only studio gets `tpdb-<shortName>`.
 *   - The Traxxx side is parsed from the listing URL and validated against the
 *     host and path shape, exactly as the watchlist lane already does.
 *   - The TPDB side is resolved to a numeric `site_id` plus its `uuid`, and the
 *     response is VERIFIED against what was declared. A TPDB site lookup
 *     resolves loosely - a slug can return a different site - so an unverified
 *     match would file another studio's releases under this studio's name.
 *
 * Ingestion is therefore: paste the studio's URLs, resolve them live, and get
 * back a checked-in declaration. `npm run link-studios` does exactly that and
 * prints the block to paste into STUDIO_LINKS.
 *
 * What this module deliberately does NOT do: guess. A studio that cannot be
 * resolved to exactly one TPDB site is reported as unresolved with the reason,
 * never bound to a near-match. A wrong link is far more expensive than a
 * missing one - it files the wrong releases and reports success.
 */
import { z } from "zod";
import { FetchError } from "../core/fetcher.ts";
import type { Fetcher } from "./types.ts";

export const TPDB_BASE = "https://api.theporndb.net";
export const TPDB_WEB_HOSTS: readonly string[] = Object.freeze([
  "theporndb.net",
  "www.theporndb.net",
]);
export const TRAXXX_WEB_HOSTS: readonly string[] = Object.freeze(["traxxx.me", "www.traxxx.me"]);

/** The TPDB site record fields this module relies on. */
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

export interface ResolvedTpdbSite {
  /** The numeric id TPDB's /scenes filter wants. */
  siteId: number;
  uuid: string | undefined;
  name: string;
  shortName: string | undefined;
  url: string | undefined;
  networkId: number | undefined;
  /** How the site was found, for the operator-facing report. */
  resolvedBy: "uuid" | "id" | "slug" | "search";
}

export interface TpdbLookup {
  /** Candidate identifiers to try against `/sites/{identifier}`, in order. */
  readonly candidates: readonly string[];
  /**
   * A UUID taken from a pasted URL, if the URL carried one. A candidate that
   * resolves to a different UUID is rejected even if its name looks right.
   */
  readonly uuid?: string;
  /**
   * A display name taken from a pasted URL, or supplied by the caller. Used to
   * verify a loose slug match, and to pick out of search results.
   */
  readonly name?: string;
  /**
   * Tag names a pasted SEARCH address asked for.
   *
   * TPDB's own `tags[...]` filter does not filter - verified 2026-10-04, every
   * tag value returns the same rows - so these are recorded and applied by the
   * caller's name match instead, which is the only path that actually works.
   */
  readonly tags?: readonly string[];
  /**
   * The `site_id` a pasted search address named, trusted as exact.
   *
   * Set only for a numeric `site_id`. It makes the lookup authoritative in the
   * same way a UUID is, which is what stops a stale display slug in the same
   * address from vetoing the site the id names.
   */
  readonly exactSiteId?: number;
}

/**
 * Strip accents, lowercase, and reduce everything that is not a letter or digit
 * to single spaces. Shared with the TPDB lane so a name verified here is
 * verified the same way there.
 */
export function cleanStudioName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function studioNameKeys(site: { name: string; short_name?: string | null }): string[] {
  return [site.name, site.short_name ?? ""].map(cleanStudioName).filter(Boolean);
}

/**
 * Parse a pasted TPDB studio URL into lookup candidates.
 *
 * TPDB's own web pages sit behind a login, so the URL shape is not something
 * this module may assume: any path under the TPDB hosts is accepted, and every
 * path segment that could plausibly be an identifier is tried. A UUID segment
 * is recognised as such because it is unambiguous. This is deliberately
 * permissive on the way IN and strict on the way OUT - the response is still
 * verified against the declared name.
 */
export function parseTpdbStudioUrl(raw: string): TpdbLookup {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`Invalid TPDB studio URL ${raw}: not a URL`);
  }
  if (url.protocol !== "https:") throw new Error(`Invalid TPDB studio URL ${raw}: must use HTTPS`);
  if (!TPDB_WEB_HOSTS.includes(url.hostname)) {
    throw new Error(`Invalid TPDB studio URL ${raw}: unsupported host ${url.hostname}`);
  }
  // The tag names a search address asked for. Read before the path is
  // interpreted, and deliberately NOT forwarded to the API later.
  const tags = readSearchTags(url, raw);
  const tagsField = tags.length ? { tags } : {};
  const nameHint = url.searchParams.get("name") ?? undefined;
  const segments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  // A UUID is the strongest identity TPDB offers, in the path or the query. It is
  // read FIRST so a `site_id` in the same address cannot quietly override it, and
  // before `site_id` is validated so junk in that parameter cannot abort an
  // otherwise complete UUID.
  const uuidParam = url.searchParams.get("uuid");
  if (uuidParam !== null && !z.string().uuid().safeParse(uuidParam).success) {
    throw new Error(`Invalid TPDB studio URL ${raw}: uuid is not a UUID`);
  }
  const uuid = uuidParam ?? segments.find((s) => z.string().uuid().safeParse(s).success);
  if (uuid) {
    return { candidates: [uuid], uuid, ...tagsField, ...(nameHint ? { name: nameHint } : {}) };
  }
  // `site_operation` is deliberately NOT read. TPDB's own implementation of it
  // is broken: on site 116701 (75 scenes) `site_operation=Network` returns 0 and
  // `site_operation=Single` returns no usable total, verified 2026-10-04. The
  // lane already requests the single site its `site_id` names, which is what a
  // `site_operation=Network` search on the wire actually resolves to. Honouring
  // the parameter as written would return nothing.
  const siteId = readSiteId(url, raw);
  // A SEARCH address carries the studio in its query string, not its path.
  // `/scenes` is a container view every search shares, so taking the last path
  // segment as the identifier here named the container - and the lookup then
  // fell back to a NAME SEARCH that could land on any site with a similar
  // name. `site_id` is the identity; the id decides, never the slug.
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
  // No uuid, so the identifier is the LAST path segment: the resource being
  // named. Earlier segments are containers (`/sites/...`) or sibling views
  // (`/scenes`), and offering them as candidates would spend requests on
  // lookups that either 404 or, worse, resolve to some unrelated site.
  const last = segments.at(-1);
  const identifier = last ? (/^\d+$/.test(last) ? last : cleanStudioName(last)) : "";
  if (!identifier) {
    throw new Error(`Invalid TPDB studio URL ${raw}: no studio identifier in the path`);
  }
  // A container view with no site_id names the CONTAINER, not a studio. Accepting
  // it would send `/sites/scenes` to the API and then let a name search pick a
  // site, which is the silent wrong-studio path this parser exists to close.
  if (isContainerSegment(last)) {
    throw new Error(
      `Invalid TPDB studio URL ${raw}: a ${identifier} search needs a site_id query parameter`,
    );
  }
  return { candidates: [identifier], ...tagsField, ...(nameHint ? { name: nameHint } : {}) };
}

/**
 * Path segments that are a view over many studios rather than one studio.
 *
 * `/scenes` is the address a person copies after filtering in the browser, so it
 * is the common case; the rest are listed so a future TPDB view is rejected the
 * same way instead of being looked up as though it named a studio.
 */
const CONTAINER_SEGMENTS: ReadonlySet<string> = new Set(
  ["scenes", "studios", "tags", "studios-scenes", "search", "categories"].map(cleanStudioName),
);

/** Whether a path segment names a container view rather than one studio. */
function isContainerSegment(segment: string | undefined): boolean {
  return segment !== undefined && CONTAINER_SEGMENTS.has(cleanStudioName(segment));
}

/**
 * Tag names from a pasted search address, keyed `tags[N]=<Name>`.
 *
 * The bracket index is read and DISCARDED. It is not a tag id: TPDB tag ids are
 * sparse and non-contiguous (id 70 and 856 are both unresolvable via
 * `/tags/{id}` while scene tags carry real ids), and passing a real tag id in
 * the index position returns nothing at all. Verified against the live API on
 * 2026-10-04: the index and the value are both ignored by TPDB, so the only
 * trustworthy reading is the tag NAME.
 */
function readSearchTags(url: URL, raw: string): string[] {
  const names = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!/^tags\[\d*\]$/.test(key)) continue;
    const name = value.trim();
    // A present-but-empty tag is a malformed address. Dropping it would produce
    // an untagged declaration and the lane would collect the WHOLE site - the one
    // outcome this change exists to prevent.
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
  // Case-insensitively de-duplicated, then ordered deterministically so the same
  // address always yields the same declaration. Folding happens BEFORE the
  // operation check, because "Anal" and "anal" are one tag and must not read as
  // a multi-tag search.
  const folded = new Map<string, string>();
  for (const name of names) {
    const key = cleanStudioName(name);
    if (key && !folded.has(key)) folded.set(key, name);
  }
  // The declaration's tag list is an ALL-of match (tpdb-watchlist.ts), so a
  // multi-tag search whose tags are ALTERNATIVES would be quietly narrowed to
  // their intersection. `tag_and` is the operation; anything that is not an
  // explicit all-of - including an omitted value, whose default is not something
  // to guess at - is refused rather than reinterpreted.
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

/**
 * The `site_id` of a pasted search address, or undefined when the address is a
 * site page rather than a search.
 *
 * Rejected rather than ignored when present but malformed: an address carrying
 * `site_id=abc` is a broken declaration, and quietly falling back to a name
 * search is how the wrong studio gets bound in the first place.
 */
function readSiteId(url: URL, raw: string): number | undefined {
  const value = url.searchParams.get("site_id");
  if (value === null) return undefined;
  // Number() silently rounds anything past MAX_SAFE_INTEGER, which would turn a
  // typo into a plausible-looking wrong site id rather than an error.
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0) {
    throw new Error(`Invalid TPDB studio URL ${raw}: site_id must be a positive integer`);
  }
  return Number(value);
}

/** `bangbros` -> `Bangbros`, for the display hint a `site=` slug carries. */
function displayNameFromSlug(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Whether a resolved site satisfies what was declared.
 *
 * `uuid` is the strongest statement and is checked whenever the pasted URL
 * carried one. Otherwise the site's own name or short name must clean to the
 * declared name - this is what stops `/sites/anything` from binding the wrong
 * studio.
 */
function siteSatisfies(site: z.infer<typeof TpdbSite>, lookup: TpdbLookup): boolean {
  if (lookup.uuid) return site.uuid === lookup.uuid;
  // A numeric `site_id` is exact by construction, the same authority a UUID has.
  // It must NOT be gated on a name: the only name available is the display slug
  // the URL happened to carry, and TPDB renames sites, so a stale or abbreviated
  // `site=` hint would otherwise veto the exact id the operator pasted.
  if (lookup.exactSiteId !== undefined) return site.id === lookup.exactSiteId;
  const wanted = cleanStudioName(lookup.name ?? "");
  if (!wanted) return false;
  return studioNameKeys(site).includes(wanted);
}

export interface ResolveResult {
  site: ResolvedTpdbSite | undefined;
  /** Why it did not resolve. `absent` is a clean no-match; the rest are errors. */
  outcome: "resolved" | "absent" | "ambiguous";
  /** Sites TPDB offered that the operator may have meant. Diagnostics only. */
  candidates: { id: number; name: string; shortName: string | undefined }[];
}

async function getSite(fetcher: Fetcher, token: string, identifier: string) {
  const url = new URL(`/sites/${encodeURIComponent(identifier)}`, TPDB_BASE).href;
  const raw = await fetcher.json(url, { headers: { Authorization: `Bearer ${token}` } });
  return TpdbSiteEnvelope.parse(raw).data;
}

/**
 * Resolve a declaration to exactly one TPDB site, or explain why not.
 *
 * Three tiers, in order of how much they can be trusted:
 *
 *  1. `uuid` / numeric `id` from the URL. Exact by construction.
 *  2. `slug` - a name from the URL, fetched directly. `/sites/{identifier}`
 *    resolves loosely, so the response is verified against the declared name.
 *  3. `search` - TPDB's `q` search. Only ever used to REPORT candidates and to
 *    accept a single unambiguous exact-name hit; a search result that merely
 *    looks similar is never bound.
 *
 * A transport failure (timeout, 5xx, malformed body) propagates. It is not an
 * absent studio: swallowing it would report a lane as working while silently
 * dropping the studios that happened to fail.
 */
export async function resolveTpdbSite(
  fetcher: Fetcher,
  token: string,
  lookup: TpdbLookup,
): Promise<ResolveResult> {
  const wanted = cleanStudioName(lookup.name ?? "");
  let sawDefinitiveMiss = false;

  for (const candidate of lookup.candidates) {
    let site: z.infer<typeof TpdbSite>;
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

  // An exact `site_id` that did not resolve is TERMINAL. Falling through to the
  // name search below would let a site that merely shares the name be written as
  // the declaration - a different numeric id than the one the operator pasted,
  // reported as resolved. A stale or removed id must report unresolved instead.
  if (lookup.exactSiteId !== undefined) {
    return { site: undefined, outcome: "absent", candidates: [] };
  }

  // Nothing verified directly. Ask TPDB what it does have, so the report can
  // name the alternatives instead of just failing.
  const search = await searchSites(fetcher, token, lookup.name ?? wanted);
  if (search === undefined) {
    // The catalogue is unreachable. Not evidence of absence.
    if (sawDefinitiveMiss) return { site: undefined, outcome: "absent", candidates: [] };
    throw new Error("TPDB studio search did not answer");
  }
  const exact = search.filter(
    (site): site is z.infer<typeof TpdbSite> =>
      Boolean(wanted) && studioNameKeys(site).includes(wanted),
  );
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

/** TPDB's name search. `undefined` means the search itself did not answer. */
async function searchSites(
  fetcher: Fetcher,
  token: string,
  query: string,
): Promise<z.infer<typeof TpdbSite>[] | undefined> {
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
      siteId: z.number().int().positive(),
      uuid: z.string().uuid().optional(),
      name: z.string().min(1),
      shortName: z.string().min(1).optional(),
      url: z.string().url().optional(),
      networkId: z.number().int().positive().optional(),
    })
    .optional(),
});

/**
 * A studio declaration: what the operator pasted, plus what it resolved to.
 * `traxxx` and `tpdb` are independently optional - a studio may exist on one
 * side only, and the lanes that do exist still run.
 */
export interface StudioLink {
  /** Liszt's key for this studio. Never changes once scenes reference it. */
  studioId: string;
  /** The display name shown in the app. */
  studio: string;
  /** Alternative spellings accepted when verifying a TPDB match. */
  aliases?: readonly string[];
  /** TPDB tags a scene must carry to belong to this lane. */
  tags?: readonly string[];
  traxxx?: {
    kind: "network" | "channel";
    slug: string;
    /** The listing URL as declared, kept for provenance and re-parsing. */
    url: string;
  };
  tpdb?: {
    siteId: number;
    uuid?: string;
    name: string;
    shortName?: string;
    url?: string;
    networkId?: number;
  };
}

/**
 * The canonical key for a studio. A Traxxx lane keeps its existing lane id, so
 * introducing explicit links cannot repoint a studio that scenes already
 * reference; anything TPDB-only is namespaced under `tpdb-` so it can never
 * collide with a lane id.
 */
export function canonicalStudioId(link: {
  traxxx?: { kind: string; slug: string };
  tags?: readonly string[];
  tpdb?: { shortName?: string; name?: string };
}): string {
  if (link.traxxx) {
    // The tags are part of the lane id, not decoration: the tagged and untagged
    // lanes for one studio are different lanes. Dropping them here would
    // declare a key that no existing lane or stored scene uses, and the studio
    // would silently ingest nothing.
    return [link.traxxx.kind, link.traxxx.slug, ...(link.tags ?? [])].join("-");
  }
  const key = cleanStudioName(link.tpdb?.shortName ?? link.tpdb?.name ?? "studio");
  return `tpdb-${key.replace(/ /g, "-")}`;
}

/** The aliases a TPDB response may legitimately match for this studio. */
export function studioAliases(link: StudioLink): string[] {
  return [...new Set([link.studio, ...(link.aliases ?? [])].map(cleanStudioName).filter(Boolean))];
}

/**
 * Check a whole declaration set for the two ways a config can silently lie:
 * two studios claiming one TPDB site, and two studios claiming one key.
 */
export function auditStudioLinks(links: readonly StudioLink[]): string[] {
  const problems: string[] = [];
  const byKey = new Map<string, string[]>();
  const bySite = new Map<number, string[]>();
  // Alias -> the studioIds claiming it. The TPDB lane resolves an alias to
  // `null` when two studios claim it, so a duplicated alias is SAFE at runtime -
  // but silently so: the lane just reports the studio as unmatched and never
  // resolves, which is indistinguishable from a studio TPDB does not carry. That
  // is exactly the failure this declaration exists to make visible, so it is
  // caught here instead.
  const byAlias = new Map<string, Set<string>>();
  for (const link of links) {
    byKey.set(link.studioId, [...(byKey.get(link.studioId) ?? []), link.studio]);
    if (link.tpdb)
      bySite.set(link.tpdb.siteId, [...(bySite.get(link.tpdb.siteId) ?? []), link.studioId]);
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
