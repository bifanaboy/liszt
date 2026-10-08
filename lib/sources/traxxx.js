const API_BASE = "https://traxxx.me";
const SCENES_URL = `${API_BASE}/api/scenes`;
export const CDN_BASE = "https://cdn.traxxx.me";
const PAGE_LIMIT = 100;
const MAX_PAGES = 200;
const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const MAX_RETRIES = 3;
const ENTITY_PREFIX = Object.freeze({
  channel: "",
  network: "_",
});
export function entityFilter(kind, slug) {
  return `${ENTITY_PREFIX[kind]}${slug}`;
}
export function parseRoster(body) {
  if (!body || typeof body !== "object") return [];
  const entries = body.aggChannels;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry;
    const slug = typeof value.slug === "string" ? value.slug.trim() : "";
    if (!slug) return [];
    const name = typeof value.name === "string" && value.name.trim() ? value.name.trim() : slug;
    const parsedCount = Number(value.count);
    const count = Number.isFinite(parsedCount) && parsedCount >= 0 ? Math.floor(parsedCount) : 0;
    return [{ slug, name, count }];
  });
}
export function recordChannel(record, fallbackSlug, fallbackName) {
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
export function parseTraxxxDate(value) {
  const text = String(value ?? "").trim();
  const iso = text.replace(/^!Date:/, "");
  return iso.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "";
}
function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}
export function parseTraxxxPoster(poster) {
  if (!poster || typeof poster !== "object") return "";
  const path =
    (typeof poster.thumbnail === "string" && poster.thumbnail) ||
    (typeof poster.path === "string" && poster.path) ||
    "";
  if (!path) return "";
  return /^https?:\/\//i.test(path) ? path : `${CDN_BASE}/${path.replace(/^\/+/, "")}`;
}
function isMaleGender(gender) {
  return (
    String(gender ?? "")
      .trim()
      .toLowerCase() === "male"
  );
}
function performerNames(actors) {
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
function tagNames(tags) {
  if (!Array.isArray(tags)) return [];
  return [
    ...new Set(
      tags.map((tag) => (typeof tag?.name === "string" ? tag.name.trim() : "")).filter(Boolean),
    ),
  ];
}
function releaseUrlFor(record, sourceSceneId) {
  const original = typeof record.url === "string" ? record.url.trim() : "";
  if (original) return original;
  const watch = typeof record.watchUrl === "string" ? record.watchUrl.trim() : "";
  if (watch) return watch;
  return `${API_BASE}/scene/${sourceSceneId}`;
}
export function parseTraxxxScene(
  record,
  { sourceUrl = SCENES_URL, kind, laneSlug = "", laneName = "" } = {},
) {
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
export function sceneMatchesEntity(record, kind, slug) {
  const entity = kind === "network" ? record?.network : record?.channel;
  return String(entity?.slug ?? "").toLowerCase() === slug.toLowerCase();
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function createExpiringCache({ ttlMs, limit = 512 }) {
  const entries = new Map();
  return function cached(key, load) {
    const now = Date.now();
    const entry = entries.get(key);
    if (entry && now - entry.createdAt < ttlMs) return entry.value;
    entries.delete(key);
    const value = Promise.resolve().then(load);
    entries.set(key, { createdAt: now, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    if (entries.size > limit) entries.delete(entries.keys().next().value);
    return value;
  };
}
export function createTraxxxClient(
  ctx,
  { minIntervalMs = DEFAULT_MIN_INTERVAL_MS, cacheTtlMs = DEFAULT_CACHE_TTL_MS } = {},
) {
  const interval = ctx.traxxx?.minIntervalMs ?? minIntervalMs;
  const ttl = ctx.traxxx?.cacheTtlMs ?? cacheTtlMs;
  const cached = createExpiringCache({ ttlMs: ttl });
  let lastRequest = 0;
  async function requestJson(url) {
    for (let attempt = 0; ; attempt += 1) {
      const wait = interval - (Date.now() - lastRequest);
      if (wait > 0) await delay(wait);
      lastRequest = Date.now();
      let response;
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
  function requiredCount(value, field) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`traxxx response has no usable "${field}" field`);
    }
    return Math.floor(parsed);
  }
  function optionalCount(value) {
    if (value === undefined || value === null || value === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : null;
  }
  function page(kind, slug, pageNumber, limit, filters = {}) {
    const url = new URL(SCENES_URL);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(pageNumber));
    url.searchParams.set("e", entityFilter(kind, slug));
    if (filters.tags?.length) url.searchParams.set("tags", filters.tags.join(","));
    return cached(url.href, async () => {
      const body = await requestJson(url.href);
      if (!body || !Array.isArray(body.scenes)) {
        throw new Error("traxxx returned an invalid response");
      }
      return {
        scenes: body.scenes,
        total: requiredCount(body.total, "total"),
        limit: optionalCount(body.limit) ?? limit,
        roster: parseRoster(body),
      };
    });
  }
  return {
    listScenes: (kind, slug, pageNumber, limit = PAGE_LIMIT, filters = {}) =>
      page(kind, slug, pageNumber, limit, filters),
    unfilteredTotal: () =>
      cached("unfiltered", async () => {
        const url = new URL(SCENES_URL);
        url.searchParams.set("limit", "1");
        const body = await requestJson(url.href);
        if (!body || typeof body !== "object")
          throw new Error("traxxx returned an invalid response");
        return requiredCount(body.total, "total");
      }),
    entityTotal: (kind, slug) =>
      cached(`entity-total:${kind}:${slug}`, async () => {
        const url = new URL(SCENES_URL);
        url.searchParams.set("limit", "1");
        url.searchParams.set("e", entityFilter(kind, slug));
        const body = await requestJson(url.href);
        if (!body || typeof body !== "object")
          throw new Error("traxxx returned an invalid response");
        return requiredCount(body.total, "total");
      }),
    async getScene(id) {
      const value = String(id);
      if (!/^\d+$/.test(value)) return null;
      const body = await requestJson(`${SCENES_URL}/${value}`);
      return body && typeof body === "object" ? body : null;
    },
  };
}
export async function assertFilterApplies(client, kind, slug, limit = PAGE_LIMIT, tags = []) {
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
function withinWindow(releaseDate, windowStart, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
  const date = new Date(`${releaseDate}T00:00:00Z`);
  return date >= new Date(`${windowStart}T00:00:00Z`) && date <= now;
}
export function createTraxxxStudio(options) {
  const { id, name, kind, slug, tags = [], creatorStudio = false, exclude } = options;
  const filter = entityFilter(kind, slug);
  const authorityUrl = `${SCENES_URL}?e=${encodeURIComponent(filter)}`;
  return {
    id,
    name,
    authority: { name: "traxxx.me", url: authorityUrl, role: "authoritative catalogue" },
    matcher: "sxyprn+eporner",
    creatorStudio,
    async fetch(windowStart, ctx) {
      const client = createTraxxxClient(ctx);
      let pageResult = await assertFilterApplies(client, kind, slug, PAGE_LIMIT, tags);
      const scenes = [];
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
          if (!sceneMatchesEntity(record, kind, slug)) {
            filtered += 1;
            ctx.log(`traxxx: ${filter} page ${page} returned a foreign record`, {
              id: record?.id,
            });
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
export async function fetchTraxxxScene(id, ctx) {
  const client = createTraxxxClient(ctx);
  const record = await client.getScene(id);
  if (!record) return null;
  return parseTraxxxScene(record, { sourceUrl: `${SCENES_URL}/${String(id)}` });
}
