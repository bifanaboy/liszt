/**
 * The traxxx.me catalogue source - category 1 of 4.
 *
 * traxxx is a REST metadata index (no API key, no auth) that mirrors the
 * studios' own catalogues, so it replaces TPDB entirely: it lists scenes per
 * channel or network and carries duration, release date, actors, tags, and the
 * studio's own release URL on every record.
 *
 * THE FILTER GUARD IS THE POINT OF THIS FILE. traxxx silently IGNORES an
 * unknown `e=` filter and returns the entire ~500k-scene index. A single typo'd
 * slug would therefore ingest the whole catalogue and present it as one studio.
 * Two defences are both mandatory and both tested:
 *
 *   1. `assertFilterApplies` compares the filtered total against the unfiltered
 *      total. Equal totals mean the filter was dropped; it throws, which keeps
 *      the source's last-good records instead of replacing them.
 *   2. `sceneMatchesEntity` re-checks every individual record's entity slug, so
 *      even a partial filter leak cannot land a foreign record.
 */
import { setTimeout as delay } from "node:timers/promises";
import type { Fetcher, RawScene, SourceAdapter, SourceResult } from "./types.ts";
import { createExpiringCache } from "../core/expiring-cache.ts";

const API_BASE = "https://traxxx.me";
const SCENES_URL = `${API_BASE}/api/scenes`;
export const CDN_BASE = "https://cdn.traxxx.me";
const PAGE_LIMIT = 100;
const MAX_PAGES = 200;
const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_RETRIES = 3;

/** The entity namespaces the scenes endpoint can filter on. */
export type TraxxxEntityKind = "channel" | "network";

/**
 * The `e` filter prefix per entity kind, taken from the front-end's own
 * mapping. A channel is the bare slug; a network is `_`-prefixed, so the two
 * can never collide.
 */
const ENTITY_PREFIX: Readonly<Record<TraxxxEntityKind, string>> = Object.freeze({
  channel: "",
  network: "_",
});

/** The `e` query value for an entity, e.g. `lancelotstyles` or `_vixen`. */
export function entityFilter(kind: TraxxxEntityKind, slug: string): string {
  return `${ENTITY_PREFIX[kind]}${slug}`;
}

export interface TraxxxEntityRef {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  type?: unknown;
  url?: unknown;
}

export interface TraxxxActor {
  id?: unknown;
  name?: unknown;
  gender?: unknown;
}

export interface TraxxxTag {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
}

export interface TraxxxPoster {
  thumbnail?: unknown;
  path?: unknown;
}

export interface TraxxxSceneRecord {
  id?: unknown;
  title?: unknown;
  slug?: unknown;
  url?: unknown;
  watchUrl?: unknown;
  date?: unknown;
  effectiveDate?: unknown;
  duration?: unknown;
  datePrecision?: unknown;
  isUpcoming?: unknown;
  channel?: TraxxxEntityRef | null;
  network?: TraxxxEntityRef | null;
  studio?: TraxxxEntityRef | null;
  actors?: TraxxxActor[];
  tags?: TraxxxTag[];
  poster?: TraxxxPoster | null;
}

export interface TraxxxScenePage {
  scenes: TraxxxSceneRecord[];
  total: number;
  limit: number;
  roster: Array<{ slug: string; name: string; count: number }>;
}

export function parseRoster(body: unknown): Array<{ slug: string; name: string; count: number }> {
  if (!body || typeof body !== "object") return [];
  const entries = (body as { aggChannels?: unknown }).aggChannels;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as { slug?: unknown; name?: unknown; count?: unknown };
    const slug = typeof value.slug === "string" ? value.slug.trim() : "";
    if (!slug) return [];
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : slug;
    const parsedCount = Number(value.count);
    const count = Number.isFinite(parsedCount) && parsedCount >= 0 ? Math.floor(parsedCount) : 0;
    return [{ slug, name, count }];
  });
}

export function recordChannel(
  record: TraxxxSceneRecord,
  fallbackSlug: string,
  fallbackName: string,
): { slug: string; name: string } {
  const slug =
    typeof record.channel?.slug === "string" && record.channel.slug.trim()
      ? record.channel.slug.trim()
      : fallbackSlug;
  const name =
    typeof record.channel?.name === "string" && record.channel.name.trim()
      ? record.channel.name.trim()
      : slug === fallbackSlug
        ? fallbackName
        : slug;
  return { slug, name };
}

/** The `date` field is serialised as `!Date:<iso>`; a bare ISO also parses. */
export function parseTraxxxDate(value: unknown): string {
  const text = String(value ?? "").trim();
  const iso = text.replace(/^!Date:/, "");
  return iso.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/** Absolute poster URL; traxxx serves posters only from its CDN. */
export function parseTraxxxPoster(poster: TraxxxPoster | null | undefined): string {
  if (!poster || typeof poster !== "object") return "";
  const path =
    (typeof poster.thumbnail === "string" && poster.thumbnail) ||
    (typeof poster.path === "string" && poster.path) ||
    "";
  if (!path) return "";
  return /^https?:\/\//i.test(path) ? path : `${CDN_BASE}/${path.replace(/^\/+/, "")}`;
}

function isMaleGender(gender: unknown): boolean {
  return (
    String(gender ?? "")
      .trim()
      .toLowerCase() === "male"
  );
}

function performerNames(actors: TraxxxActor[] | undefined): string[] {
  if (!Array.isArray(actors)) return [];
  return [
    ...new Set(
      actors
        .filter((actor) => !isMaleGender(actor?.gender))
        .map((actor) => (typeof actor?.name === "string" ? actor.name.trim() : ""))
        .filter(Boolean),
    ),
  ];
}

function tagNames(tags: TraxxxTag[] | undefined): string[] {
  if (!Array.isArray(tags)) return [];
  return [
    ...new Set(
      tags.map((tag) => (typeof tag?.name === "string" ? tag.name.trim() : "")).filter(Boolean),
    ),
  ];
}

/** The studio's own page: prefer the original site URL, else the watch URL. */
function releaseUrlFor(record: TraxxxSceneRecord, sourceSceneId: string): string {
  const original = typeof record.url === "string" ? record.url.trim() : "";
  if (original) return original;
  const watch = typeof record.watchUrl === "string" ? record.watchUrl.trim() : "";
  if (watch) return watch;
  return `${API_BASE}/scene/${sourceSceneId}`;
}

/**
 * Map one traxxx record to a raw scene. Throws when the id or title is missing,
 * so a malformed page names the source instead of emitting a partial record.
 */
export function parseTraxxxScene(
  record: TraxxxSceneRecord,
  {
    sourceUrl = SCENES_URL,
    kind,
    laneSlug = "",
    laneName = "",
  }: {
    sourceUrl?: string;
    kind?: TraxxxEntityKind;
    laneSlug?: string;
    laneName?: string;
  } = {},
): RawScene {
  const sourceSceneId = record?.id === undefined || record?.id === null ? "" : String(record.id);
  if (!sourceSceneId || !record.title) throw new Error("traxxx scene is missing its ID or title");
  const releaseUrl = releaseUrlFor(record, sourceSceneId);
  const studio = kind === "network" ? recordChannel(record, laneSlug, laneName) : null;
  return {
    sourceSceneId,
    title: String(record.title).trim(),
    releaseDate: parseTraxxxDate(record.date ?? record.effectiveDate),
    performers: performerNames(record.actors),
    durationSec: numeric(record.duration),
    thumbnailUrl: parseTraxxxPoster(record.poster),
    releaseUrl,
    tags: tagNames(record.tags),
    source: "traxxx.me",
    provenance: { source: "traxxx.me", sourceUrl, recordUrl: releaseUrl, sourceSceneId },
    ...(studio ? { studioId: studio.slug, studio: studio.name } : {}),
  };
}

/** True when a record's entity slug matches the filter that fetched it. */
export function sceneMatchesEntity(
  record: TraxxxSceneRecord,
  kind: TraxxxEntityKind,
  slug: string,
): boolean {
  const entity = kind === "network" ? record?.network : record?.channel;
  return String(entity?.slug ?? "").toLowerCase() === slug.toLowerCase();
}

export interface TraxxxClientOptions {
  /** Minimum spacing between this client's outbound requests. */
  minIntervalMs?: number;
  /** How long a page response is reused (per client, i.e. per run). */
  cacheTtlMs?: number;
}

export interface TraxxxClient {
  /** One page of scene records for an entity, newest first. */
  listScenes(
    kind: TraxxxEntityKind,
    slug: string,
    page: number,
    limit?: number,
    filters?: { tags?: readonly string[] },
  ): Promise<TraxxxScenePage>;
  /** Pull one scene by numeric id. Returns null when the id does not exist. */
  getScene(id: string | number): Promise<TraxxxSceneRecord | null>;
  /** The unfiltered scene total, used to detect a silently-ignored filter. */
  unfilteredTotal(): Promise<number>;
  /** The same entity without tag filters, used to detect dropped tags. */
  entityTotal(kind: TraxxxEntityKind, slug: string): Promise<number>;
}

/** A politeness-bounded, caching traxxx client. One per run keeps pacing local. */
export function createTraxxxClient(
  ctx: { fetcher: Fetcher; traxxx?: TraxxxClientOptions },
  {
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  }: TraxxxClientOptions = {},
): TraxxxClient {
  const interval = ctx.traxxx?.minIntervalMs ?? minIntervalMs;
  const ttl = ctx.traxxx?.cacheTtlMs ?? cacheTtlMs;
  const cached = createExpiringCache({ ttlMs: ttl });
  let lastRequest = 0;

  async function requestJson(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const wait = interval - (Date.now() - lastRequest);
      if (wait > 0) await delay(wait);
      lastRequest = Date.now();
      let response: Response;
      try {
        response = await ctx.fetcher.fetch(url, { headers: { accept: "application/json" } });
      } catch (error) {
        if (attempt < MAX_RETRIES) {
          await delay(Math.min(1000 * 2 ** attempt, 15_000));
          continue;
        }
        throw error;
      }
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 30_000)
            : Math.min(1000 * 2 ** attempt, 15_000),
        );
        continue;
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`traxxx request failed with HTTP ${response.status}`);
      return response.json();
    }
  }

  /**
   * A count field, read strictly.
   *
   * `Number(body.total) || 0` was a false-empty: a MISSING or renamed `total`
   * became `0`, and `0` is not a harmless placeholder here. It is the page
   * count, so a real `0` ends the walk after one page, and the unfiltered total
   * is the baseline the entity-filter guard compares against - with one side
   * silently `0` the guard has nothing to compare and cannot fire. A response
   * that stopped carrying the field is a shape change, so it throws.
   */
  function requiredCount(value: unknown, field: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`traxxx response has no usable "${field}" field`);
    }
    return Math.floor(parsed);
  }

  /** The same read, but a missing field falls back rather than throwing. */
  function optionalCount(value: unknown): number | null {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  }

  function page(
    kind: TraxxxEntityKind,
    slug: string,
    pageNumber: number,
    limit: number,
    filters: { tags?: readonly string[] } = {},
  ): Promise<TraxxxScenePage> {
    const url = new URL(SCENES_URL);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("e", entityFilter(kind, slug));
    if (filters.tags?.length) url.searchParams.set("tags", filters.tags.join(","));
    return cached(url.href, async () => {
      const body = (await requestJson(url.href)) as {
        scenes?: unknown;
        total?: unknown;
        limit?: unknown;
      } | null;
      if (!body || !Array.isArray(body.scenes)) {
        throw new Error("traxxx returned an invalid response");
      }
      return {
        scenes: body.scenes as TraxxxSceneRecord[],
        total: requiredCount(body.total, "total"),
        limit: optionalCount(body.limit) ?? limit,
        roster: parseRoster(body),
      } satisfies TraxxxScenePage;
    });
  }

  return {
    listScenes: (kind, slug, pageNumber, limit = PAGE_LIMIT, filters = {}) =>
      page(kind, slug, pageNumber, limit, filters),
    unfilteredTotal: () =>
      cached("unfiltered", async () => {
        const url = new URL(SCENES_URL);
        url.searchParams.set("limit", "1");
        const body = (await requestJson(url.href)) as { total?: unknown } | null;
        if (!body || typeof body !== "object")
          throw new Error("traxxx returned an invalid response");
        return requiredCount(body.total, "total");
      }),
    entityTotal: (kind, slug) =>
      cached(`entity-total:${kind}:${slug}`, async () => {
        const url = new URL(SCENES_URL);
        url.searchParams.set("limit", "1");
        url.searchParams.set("e", entityFilter(kind, slug));
        const body = (await requestJson(url.href)) as { total?: unknown } | null;
        if (!body || typeof body !== "object")
          throw new Error("traxxx returned an invalid response");
        return requiredCount(body.total, "total");
      }),
    async getScene(id) {
      const value = String(id);
      if (!/^\d+$/.test(value)) return null;
      const body = (await requestJson(`${SCENES_URL}/${value}`)) as TraxxxSceneRecord | null;
      return body && typeof body === "object" ? body : null;
    },
  };
}

/**
 * THE LIST GUARD. An unknown entity slug makes traxxx return the entire index,
 * so a filtered total equal to the unfiltered total means the filter was
 * silently dropped. Throwing preserves the source's last-good records. The
 * first page is returned so the caller pays for it only once.
 */
export async function assertFilterApplies(
  client: TraxxxClient,
  kind: TraxxxEntityKind,
  slug: string,
  limit = PAGE_LIMIT,
  tags: readonly string[] = [],
): Promise<TraxxxScenePage> {
  const [firstPage, baseline] = await Promise.all([
    client.listScenes(kind, slug, 1, limit, { tags }),
    tags.length ? client.entityTotal(kind, slug) : client.unfilteredTotal(),
  ]);
  if (baseline > 0 && firstPage.total === baseline) {
    if (tags.length) {
      throw new Error(
        `traxxx tag filter ${tags.join(",")} for ${entityFilter(kind, slug)} was ignored`,
      );
    }
    throw new Error(
      `traxxx entity filter ${entityFilter(kind, slug)} matched nothing (fell back to the full index)`,
    );
  }
  return firstPage;
}

export interface TraxxxStudioOptions {
  id: string;
  name: string;
  /** The entity namespace this studio maps to on traxxx. */
  kind: TraxxxEntityKind;
  /** The traxxx slug, e.g. `lancelotstyles` or `vixen` (for a network). */
  slug: string;
  /** Optional tag slugs supplied by a validated watchlist URL. */
  tags?: readonly string[];
  creatorStudio?: boolean;
  /**
   * Drop a record the studio itself marks as unwanted, e.g. Woodman Casting X's
   * `XXXX` scenes (#82). It runs after the entity and date boundary checks,
   * before parsing the full scene,
   * so an excluded record costs one already-paid request and nothing else.
   */
  exclude?: (record: TraxxxSceneRecord) => boolean;
}

function withinWindow(releaseDate: string, windowStart: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
  const date = new Date(`${releaseDate}T00:00:00Z`);
  return date >= new Date(`${windowStart}T00:00:00Z`) && date <= now;
}

/**
 * A studio backed by one traxxx channel or network. Paginates newest-first and
 * stops at the first page whose oldest record predates the rolling window, so a
 * sync stays bounded by the window even though the API exposes no date filter.
 */
export function createTraxxxStudio(options: TraxxxStudioOptions): SourceAdapter {
  const { id, name, kind, slug, tags = [], creatorStudio = false, exclude } = options;
  const filter = entityFilter(kind, slug);
  const authorityUrl = `${SCENES_URL}?e=${encodeURIComponent(filter)}`;
  return {
    id,
    name,
    authority: { name: "traxxx.me", url: authorityUrl, role: "authoritative catalogue" },
    matcher: "sxyprn+eporner",
    creatorStudio,
    async fetch(windowStart, ctx): Promise<SourceResult> {
      const client = createTraxxxClient(ctx);
      let pageResult = await assertFilterApplies(client, kind, slug, PAGE_LIMIT, tags);
      const scenes: RawScene[] = [];
      let recordsSeen = 0;
      let filtered = 0;
      let excluded = 0;
      const labels = pageResult.roster.map((entry) => ({
        labelId: entry.slug,
        label: entry.name,
        sceneCount: entry.count,
      }));
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { scenes: records, limit } = pageResult;
        if (!records.length) break;
        let reachedWindowBoundary = false;
        for (const record of records) {
          recordsSeen += 1;
          // Second line of defence: a leaked record never lands, even if the
          // total-count guard somehow passed.
          if (!sceneMatchesEntity(record, kind, slug)) {
            // Counted, not logged: a foreign-record flood would hit the log
            // rate cap the same way madouqu's per-post lines did. One summary
            // line per lane carries the count; the ids stay in the guard.
            filtered += 1;
            continue;
          }
          const releaseDate = parseTraxxxDate(record.date ?? record.effectiveDate);
          const beforeWindow = releaseDate !== "" && releaseDate < windowStart;
          if (beforeWindow) reachedWindowBoundary = true;
          if (exclude?.(record)) {
            filtered += 1;
            excluded += 1;
            continue;
          }
          const parsed = parseTraxxxScene(record, {
            sourceUrl: authorityUrl,
            kind,
            laneSlug: slug,
            laneName: name,
          });
          if (beforeWindow) {
            filtered += 1;
            continue;
          }
          if (!withinWindow(releaseDate, windowStart, ctx.now)) {
            filtered += 1;
            continue;
          }
          scenes.push(parsed);
        }
        if (reachedWindowBoundary || records.length < limit) break;
        pageResult = await client.listScenes(kind, slug, page + 1, PAGE_LIMIT, { tags });
      }
      ctx.log("traxxx: lane complete", {
        records: recordsSeen,
        emitted: scenes.length,
        filtered,
        excluded,
      });
      return {
        scenes,
        verifiedEmpty: scenes.length === 0,
        ...(kind === "network" ? { labels } : {}),
      };
    },
  };
}

/** Pull one scene's metadata by id. Exported for targeted lookups and tests. */
export async function fetchTraxxxScene(
  id: string | number,
  ctx: { fetcher: Fetcher; traxxx?: TraxxxClientOptions },
): Promise<RawScene | null> {
  const client = createTraxxxClient(ctx);
  const record = await client.getScene(id);
  if (!record) return null;
  return parseTraxxxScene(record, { sourceUrl: `${SCENES_URL}/${String(id)}` });
}
