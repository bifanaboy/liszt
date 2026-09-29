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
import type { Fetcher, RawScene, SourceAdapter, SourceResult } from "./types.ts";

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
  return String(gender ?? "").trim().toLowerCase() === "male";
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
  { sourceUrl = SCENES_URL }: { sourceUrl?: string } = {},
): RawScene {
  const sourceSceneId = record?.id === undefined || record?.id === null ? "" : String(record.id);
  if (!sourceSceneId || !record.title) throw new Error("traxxx scene is missing its ID or title");
  const releaseUrl = releaseUrlFor(record, sourceSceneId);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createExpiringCache({ ttlMs, limit = 512 }: { ttlMs: number; limit?: number }) {
  const entries = new Map<string, { createdAt: number; value: Promise<unknown> }>();
  return function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = entries.get(key);
    if (entry && now - entry.createdAt < ttlMs) return entry.value as Promise<T>;
    entries.delete(key);
    const value = Promise.resolve().then(load);
    entries.set(key, { createdAt: now, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    if (entries.size > limit) entries.delete(entries.keys().next().value as string);
    return value;
  };
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
  ): Promise<TraxxxScenePage>;
  /** Pull one scene by numeric id. Returns null when the id does not exist. */
  getScene(id: string | number): Promise<TraxxxSceneRecord | null>;
  /** The unfiltered scene total, used to detect a silently-ignored filter. */
  unfilteredTotal(): Promise<number>;
}

/** A politeness-bounded, caching traxxx client. One per run keeps pacing local. */
export function createTraxxxClient(
  ctx: { fetcher: Fetcher; traxxx?: TraxxxClientOptions },
  { minIntervalMs = DEFAULT_MIN_INTERVAL_MS, cacheTtlMs = DEFAULT_CACHE_TTL_MS }: TraxxxClientOptions = {},
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

  function page(
    kind: TraxxxEntityKind,
    slug: string,
    pageNumber: number,
    limit: number,
  ): Promise<TraxxxScenePage> {
    const url = new URL(SCENES_URL);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("e", entityFilter(kind, slug));
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
        total: Number(body.total) || 0,
        limit: Number(body.limit) || limit,
      } satisfies TraxxxScenePage;
    });
  }

  return {
    listScenes: (kind, slug, pageNumber, limit = PAGE_LIMIT) => page(kind, slug, pageNumber, limit),
    unfilteredTotal: () =>
      cached("unfiltered", async () => {
        const url = new URL(SCENES_URL);
        url.searchParams.set("limit", "1");
        const body = (await requestJson(url.href)) as { total?: unknown } | null;
        if (!body || typeof body !== "object") throw new Error("traxxx returned an invalid response");
        return Number(body.total) || 0;
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
): Promise<TraxxxScenePage> {
  const [firstPage, unfiltered] = await Promise.all([
    client.listScenes(kind, slug, 1, limit),
    client.unfilteredTotal(),
  ]);
  if (unfiltered > 0 && firstPage.total === unfiltered) {
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
  windowDays?: number;
  creatorStudio?: boolean;
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
  const { id, name, kind, slug, windowDays = 90, creatorStudio = false } = options;
  const filter = entityFilter(kind, slug);
  const authorityUrl = `${SCENES_URL}?e=${encodeURIComponent(filter)}`;
  return {
    id,
    name,
    windowDays,
    authority: { name: "traxxx.me", url: authorityUrl, role: "authoritative catalogue" },
    matcher: "sxyprn+eporner",
    creatorStudio,
    async fetch(windowStart, ctx): Promise<SourceResult> {
      const client = createTraxxxClient(ctx);
      let pageResult = await assertFilterApplies(client, kind, slug);
      const scenes: RawScene[] = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const { scenes: records, limit } = pageResult;
        if (!records.length) break;
        let pageHasRecent = false;
        for (const record of records) {
          // Second line of defence: a leaked record never lands, even if the
          // total-count guard somehow passed.
          if (!sceneMatchesEntity(record, kind, slug)) {
            ctx.log(`traxxx: ${filter} page ${page} returned a foreign record`, {
              id: record?.id,
            });
            continue;
          }
          const parsed = parseTraxxxScene(record, { sourceUrl: authorityUrl });
          if (!withinWindow(parsed.releaseDate, windowStart, ctx.now)) continue;
          pageHasRecent = true;
          scenes.push(parsed);
        }
        if (!pageHasRecent || records.length < limit) break;
        pageResult = await client.listScenes(kind, slug, page + 1);
      }
      return { scenes, verifiedEmpty: scenes.length === 0 };
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
