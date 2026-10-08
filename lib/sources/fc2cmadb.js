import { parseClockDuration } from "../parse-clock.js";
import { findTransExclusion, TRANS_EXCLUSION_TERMS } from "./trans-exclusion.js";
export const FC2_TRANS_TERMS = TRANS_EXCLUSION_TERMS;
export const FC2CMADB_ID = "fc2cmadb";
export const FC2CMADB_LANE = "FC2";
export const FC2CMADB_BASE = "https://fc2cmadb.com";
export const FC2_ANAL_TAG_NAME = "アナル";
export const FC2_ANAL_TAG_ID = 47;
export const FC2_LISTING_URL = `${FC2CMADB_BASE}/tags/${encodeURIComponent(FC2_ANAL_TAG_NAME)}`;
export const fc2RecordUrl = (videoId) => `${FC2CMADB_BASE}/articles/${videoId}`;
export const FC2_LISTING_PAGE_SIZE = 30;
export const DEFAULT_FC2_LISTING_INTERVAL_MS = 2000;
export const DEFAULT_FC2_DETAIL_INTERVAL_MS = 8500;
export const DEFAULT_FC2_MAX_DETAIL_CHECKS = 20;
export const DEFAULT_FC2_RECHECK_DAYS = 7;
export const DEFAULT_FC2_MAX_LISTING_PAGES = 40;
export class Fc2SourceError extends Error {
  constructor(message) {
    super(message);
    this.name = "Fc2SourceError";
  }
}
export class Fc2RemovedRecordError extends Fc2SourceError {}
export class Fc2RateLimitedError extends Fc2SourceError {
  constructor() {
    super(
      "fc2cmadb.com rate-limited the FC2 lane (HTTP 429). The site asks for slow, paced reads, so the run failed rather than returning a partial walk; the lane's last-good scenes are retained.",
    );
    this.name = "Fc2RateLimitedError";
  }
}
export class Fc2ShapeError extends Fc2SourceError {
  constructor(detail) {
    super(
      `fc2cmadb.com returned an unrecognised page (${detail}). The lane cannot trust this response, so the run failed and its last-good scenes are retained.`,
    );
    this.name = "Fc2ShapeError";
  }
}
export function extractInertiaPage(html) {
  const body = String(html);
  const match = body.match(
    /<script[^>]*\bdata-page=["'][^"']*["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) throw new Fc2ShapeError("no Inertia page payload");
  const asSent = match[1];
  const unescaped = asSent
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  let parsed;
  try {
    parsed = JSON.parse(asSent);
  } catch (error) {
    try {
      parsed = JSON.parse(unescaped);
    } catch {
      throw new Fc2ShapeError(`page payload is not valid JSON (${error.message})`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Fc2ShapeError("page payload is not an object");
  }
  const record = parsed;
  const props = record.props;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new Fc2ShapeError("page payload has no props object");
  }
  return {
    component: typeof record.component === "string" ? record.component : "",
    props: props,
    url: typeof record.url === "string" ? record.url : null,
    version: typeof record.version === "string" ? record.version : null,
  };
}
function dateOnlyOf(value) {
  return typeof value === "string" ? (value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "") : "";
}
function truthyFlag(value) {
  return value === 1 || value === true || value === "1";
}
function parseListingRecord(value) {
  if (!value || typeof value !== "object") return null;
  const record = value;
  const rawId = record.video_id;
  const videoId = rawId === undefined || rawId === null ? "" : String(rawId).trim();
  if (!/^\d+$/.test(videoId)) return null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return null;
  const pivot = record.pivot;
  const tagId =
    pivot && typeof pivot === "object" ? Number(pivot.tag_id ?? Number.NaN) : Number.NaN;
  return {
    videoId,
    title,
    releaseDate: dateOnlyOf(record.release_date),
    duration: typeof record.duration === "string" ? record.duration : null,
    censored: typeof record.censored === "string" ? record.censored : null,
    notFound: truthyFlag(record.not_found),
    tagId: Number.isFinite(tagId) ? tagId : null,
    thumbnailUrl: typeof record.image_url === "string" ? record.image_url : "",
  };
}
export function parseFc2Listing(page) {
  if (page.component !== "Tags/Show") {
    throw new Fc2ShapeError(`expected the Tags/Show component, saw "${page.component}"`);
  }
  const tagName = page.props.tag_name;
  if (typeof tagName !== "string" || tagName.trim() !== FC2_ANAL_TAG_NAME) {
    throw new Fc2ShapeError(
      `expected the ${FC2_ANAL_TAG_NAME} tag listing, saw "${String(tagName)}"`,
    );
  }
  const articles = page.props.articles;
  if (!articles || typeof articles !== "object" || Array.isArray(articles)) {
    throw new Fc2ShapeError("the tag listing carries no articles paginator");
  }
  const paginator = articles;
  if (!Array.isArray(paginator.data)) {
    throw new Fc2ShapeError("the tag listing has no article array");
  }
  const cursor = paginator.next_cursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw new Fc2ShapeError("the tag listing has no usable next cursor");
  }
  const records = [];
  for (const entry of paginator.data) {
    const record = parseListingRecord(entry);
    if (!record) throw new Fc2ShapeError("the listing contains a malformed article");
    records.push(record);
  }
  return { records, nextCursor: cursor === null ? null : cursor };
}
export function parseFc2Detail(page) {
  if (page.component !== "Articles/Show") {
    throw new Fc2ShapeError(`expected the Articles/Show component, saw "${page.component}"`);
  }
  const article = page.props.article;
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    throw new Fc2ShapeError("the article page carries no article");
  }
  const record = article;
  const rawId = record.video_id;
  const videoId = rawId === undefined || rawId === null ? "" : String(rawId).trim();
  if (!/^\d+$/.test(videoId)) throw new Fc2ShapeError("the article has no usable release id");
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) throw new Fc2ShapeError(`article ${videoId} has no title`);
  if (
    !Array.isArray(record.tags) ||
    record.tags.some(
      (tag) => !tag || typeof tag !== "object" || typeof tag.name !== "string" || !tag.name.trim(),
    )
  )
    throw new Fc2ShapeError(`article ${videoId} has no usable full tag list`);
  const duration = typeof record.duration === "string" ? record.duration : null;
  const writer = record.writer;
  return {
    videoId,
    title,
    releaseDate: dateOnlyOf(record.release_date),
    duration,
    durationSec: parseClockDuration(duration),
    censored: typeof record.censored === "string" ? record.censored : null,
    notFound: truthyFlag(record.not_found),
    tags: Array.isArray(record.tags)
      ? [
          ...new Set(
            record.tags
              .map((tag) => (tag && typeof tag === "object" ? String(tag.name ?? "").trim() : ""))
              .filter(Boolean),
          ),
        ]
      : [],
    thumbnailUrl: typeof record.image_url === "string" ? record.image_url : "",
    seller: writer && typeof writer === "object" ? String(writer.name ?? "").trim() || null : null,
  };
}
export const FC2_SAFETY_TERMS = Object.freeze([
  "小学生",
  "中学生",
  "高校生",
  "幼児",
  "幼女",
  "児童",
  "子供",
  "子ども",
  "女の子",
  "未成年",
  "ロリ",
  "ペド",
  "loli",
  "lolicon",
  "shota",
  "underage",
]);
const FC2_SAFETY_WORD_TERMS = Object.freeze([
  "child",
  "children",
  "teen",
  "teens",
  "schoolgirl",
  "schoolboy",
  "femboy",
]);
function matchesLatinTerm(haystack, term) {
  return new RegExp(
    `(^|[^0-9a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9a-z]|$)`,
    "i",
  ).test(haystack);
}
function firstMatch(haystack, terms) {
  const lower = haystack.toLowerCase();
  for (const term of terms) if (lower.includes(term.toLowerCase())) return term;
  return null;
}
function firstWordMatch(haystack, terms) {
  for (const term of terms) if (matchesLatinTerm(haystack, term)) return term;
  return null;
}
export function classifyFc2Candidate(input) {
  const haystack = [input.title, ...input.tags].join("\n");
  if (input.notFound) return { status: "excluded", verdict: "record removed from the site" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.releaseDate)) {
    return { status: "excluded", verdict: "no release date" };
  }
  const safety =
    firstMatch(haystack, FC2_SAFETY_TERMS) ?? firstWordMatch(haystack, FC2_SAFETY_WORD_TERMS);
  if (safety) return { status: "excluded", verdict: `safety exclusion: ${safety}` };
  const trans = findTransExclusion(haystack);
  if (trans) return { status: "excluded", verdict: `trans/crossdress exclusion: ${trans}` };
  if (!(input.durationSec !== null && input.durationSec > 0)) {
    return {
      status: "excluded",
      verdict: "no playable duration (an image set or an unplayable record)",
    };
  }
  if (input.censored === "有") return { status: "excluded", verdict: "censored" };
  if (input.censored === "無") return { status: "accepted", verdict: "explicitly uncensored" };
  return { status: "pending", verdict: "censorship badge unmarked" };
}
export function toFc2RawScene(detail, verdict) {
  return {
    sourceSceneId: detail.videoId,
    title: detail.title,
    releaseDate: detail.releaseDate,
    performers: [],
    durationSec: detail.durationSec,
    thumbnailUrl: detail.thumbnailUrl,
    releaseUrl: fc2RecordUrl(detail.videoId),
    tags: detail.tags,
    source: FC2CMADB_BASE,
    provenance: {
      source: FC2CMADB_BASE,
      sourceUrl: FC2_LISTING_URL,
      recordUrl: fc2RecordUrl(detail.videoId),
      sourceSceneId: detail.videoId,
      audit: { fc2Censorship: verdict.verdict, fc2Tag: FC2_ANAL_TAG_NAME },
    },
  };
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function pacing(lastRequest, intervalMs, sleep) {
  return async () => {
    const wait = intervalMs - (Date.now() - lastRequest.at);
    if (wait > 0) await sleep(wait);
    lastRequest.at = Date.now();
  };
}
export function createFc2Client(
  ctx,
  {
    listingMinIntervalMs = DEFAULT_FC2_LISTING_INTERVAL_MS,
    detailMinIntervalMs = DEFAULT_FC2_DETAIL_INTERVAL_MS,
    sleep = defaultSleep,
  } = {},
) {
  const listingGate = { at: 0 };
  const detailGate = { at: 0 };
  const waitListing = pacing(listingGate, listingMinIntervalMs, sleep);
  const waitDetail = pacing(detailGate, detailMinIntervalMs, sleep);
  async function html(url, wait, detail = false) {
    await wait();
    const response = await ctx.fetcher.fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (response.status === 429) throw new Fc2RateLimitedError();
    if (response.status === 404 || response.status === 410) {
      if (detail)
        throw new Fc2RemovedRecordError(`record removed from the site (HTTP ${response.status})`);
      throw new Fc2SourceError(`fc2cmadb.com has no page at ${url} (HTTP ${response.status})`);
    }
    if (!response.ok) {
      throw new Fc2SourceError(`fc2cmadb.com request failed with HTTP ${response.status}`);
    }
    return response.text();
  }
  return {
    async listAnalTag(cursor) {
      const url = cursor
        ? `${FC2_LISTING_URL}?cursor=${encodeURIComponent(cursor)}`
        : FC2_LISTING_URL;
      return parseFc2Listing(extractInertiaPage(await html(url, waitListing)));
    },
    async getArticle(videoId) {
      if (!/^\d+$/.test(videoId)) throw new Fc2ShapeError(`"${videoId}" is not a release id`);
      const detail = parseFc2Detail(
        extractInertiaPage(await html(fc2RecordUrl(videoId), waitDetail, true)),
      );
      if (detail.videoId !== videoId)
        throw new Fc2ShapeError(`expected article ${videoId}, saw ${detail.videoId}`);
      return detail;
    },
  };
}
export async function walkFc2Listing(
  client,
  windowStart,
  { maxPages = DEFAULT_FC2_MAX_LISTING_PAGES, log } = {},
) {
  const state = { cursor: null, pages: 0, seen: new Set() };
  const records = [];
  const boundary = new Date(`${windowStart}T00:00:00Z`).getTime();
  for (let page = 1; page <= maxPages; page += 1) {
    const listing = await client.listAnalTag(state.cursor);
    state.pages = page;
    const fresh = listing.records.filter((record) => !state.seen.has(record.videoId));
    for (const record of fresh) state.seen.add(record.videoId);
    records.push(...fresh);
    const inWindow = listing.records.filter((record) => {
      const at = Date.parse(`${record.releaseDate}T00:00:00Z`);
      return Number.isFinite(at) && at >= boundary;
    });
    if (!inWindow.length) {
      log?.("fc2: listing walk reached the window edge", { page, records: fresh.length });
      return {
        records,
        pages: page,
        reachedEnd: true,
        edgeStop: listing.nextCursor !== null,
      };
    }
    if (listing.nextCursor === null)
      return { records, pages: page, reachedEnd: true, edgeStop: false };
    const seenBefore = state.cursor;
    state.cursor = listing.nextCursor;
    if (seenBefore !== null && state.cursor === seenBefore) {
      throw new Fc2ShapeError("the listing returned a repeated cursor, so the walk cannot advance");
    }
    if (page === maxPages) {
      throw new Fc2SourceError(
        `fc2 listing walk hit its ${maxPages}-page ceiling before leaving the window (incomplete walk)`,
      );
    }
  }
  throw new Fc2SourceError(`fc2 listing walk hit its ${maxPages}-page ceiling (incomplete walk)`);
}
function withinWindow(releaseDate, windowStart, now) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
  const at = Date.parse(`${releaseDate}T00:00:00Z`);
  return Number.isFinite(at) && at >= Date.parse(`${windowStart}T00:00:00Z`) && at <= now.getTime();
}
export function createFc2CmadbStudio(options = {}) {
  const {
    store = null,
    maxDetailChecksPerSync = DEFAULT_FC2_MAX_DETAIL_CHECKS,
    recheckDays = DEFAULT_FC2_RECHECK_DAYS,
    maxListingPages = DEFAULT_FC2_MAX_LISTING_PAGES,
    ...clientOptions
  } = options;
  const budget = Math.max(0, Math.floor(maxDetailChecksPerSync));
  return {
    id: FC2CMADB_ID,
    name: "FC2 (fc2cmadb)",
    authority: {
      name: FC2CMADB_BASE,
      url: FC2_LISTING_URL,
      role: `authoritative catalogue: ${FC2_ANAL_TAG_NAME} tag listing`,
    },
    matcher: "sxyprn+eporner",
    async fetch(windowStart, ctx) {
      const client = createFc2Client(ctx, clientOptions);
      const now = ctx.now;
      let retired = 0;
      const walk = await walkFc2Listing(client, windowStart, {
        maxPages: maxListingPages,
        log: ctx.log,
      });
      walk.records = walk.records.filter(
        (record) =>
          record.tagId === FC2_ANAL_TAG_ID && withinWindow(record.releaseDate, windowStart, now),
      );
      if (store) {
        await store.deleteFc2CandidatesBefore(windowStart);
        await store.noteFc2Sightings(
          walk.records.map((record) => ({
            videoId: record.videoId,
            releaseDate: record.releaseDate,
          })),
          now.toISOString(),
        );
      }
      const listingExcluded = new Set(
        walk.records
          .filter((record) => record.notFound || record.censored === "有")
          .map((record) => record.videoId),
      );
      for (const record of walk.records) {
        if (!listingExcluded.has(record.videoId)) continue;
        await store?.decideFc2Candidate(
          record.videoId,
          "excluded",
          record.notFound ? "record removed from the site" : "censored",
          {
            checkedAt: now.toISOString(),
            recheckAt: null,
            scene: null,
          },
        );
      }
      const states = store
        ? await store.fc2Candidates(walk.records.map((record) => record.videoId))
        : new Map();
      const inWindowIds = walk.records
        .filter(
          (record) =>
            !listingExcluded.has(record.videoId) &&
            withinWindow(record.releaseDate, windowStart, now),
        )
        .map((record) => record.videoId);
      const due = store
        ? await store.fc2DueCandidates(now, budget)
        : inWindowIds
            .filter((videoId) => states.get(videoId)?.status !== "accepted")
            .slice(0, budget)
            .map(
              (videoId) =>
                states.get(videoId) ?? {
                  videoId,
                  releaseDate: "",
                  status: "pending",
                  verdict: "",
                  scene: null,
                  firstSeenAt: now.toISOString(),
                  checkedAt: null,
                  recheckAt: null,
                  retiredAt: null,
                },
            );
      const recheckAt = new Date(now.getTime() + recheckDays * 86_400_000).toISOString();
      const excludedSceneIds = new Set(listingExcluded);
      for (const candidate of states.values())
        if (candidate.status === "excluded") excludedSceneIds.add(candidate.videoId);
      const fresh = new Map();
      let checked = 0;
      let classifiedPending = 0;
      let detailFailure = null;
      for (const candidate of due) {
        let detail;
        try {
          detail = await client.getArticle(candidate.videoId);
        } catch (error) {
          if (error instanceof Fc2RemovedRecordError) {
            excludedSceneIds.add(candidate.videoId);
            await store?.decideFc2Candidate(candidate.videoId, "excluded", error.message, {
              checkedAt: now.toISOString(),
              recheckAt: null,
              scene: null,
            });
            checked += 1;
            continue;
          }
          ctx.log("fc2: detail check failed, leaving the candidate pending", {
            videoId: candidate.videoId,
            error: error.message,
          });
          detailFailure ??= error;
          continue;
        }
        checked += 1;
        const verdict = classifyFc2Candidate({
          durationSec: detail?.durationSec ?? null,
          censored: detail.censored,
          notFound: detail.notFound,
          releaseDate: detail.releaseDate,
          title: detail.title,
          tags: detail.tags,
        });
        const scene = verdict.status === "accepted" ? toFc2RawScene(detail, verdict) : null;
        if (scene) fresh.set(candidate.videoId, scene);
        if (verdict.status === "excluded") excludedSceneIds.add(candidate.videoId);
        if (verdict.status === "pending") classifiedPending += 1;
        await store?.decideFc2Candidate(candidate.videoId, verdict.status, verdict.verdict, {
          checkedAt: now.toISOString(),
          recheckAt: verdict.status === "pending" ? (candidate.recheckAt ?? recheckAt) : null,
          scene: scene ?? null,
        });
        if (store && verdict.status === "pending" && candidate.recheckAt !== null) {
          retired += await store.retireFc2StalePending(candidate.videoId, now);
        }
      }
      if (detailFailure !== null) throw detailFailure;
      const scenes = [];
      let undecided = 0;
      for (const record of walk.records) {
        if (
          listingExcluded.has(record.videoId) ||
          !withinWindow(record.releaseDate, windowStart, now)
        )
          continue;
        const accepted = fresh.get(record.videoId);
        if (accepted && withinWindow(accepted.releaseDate, windowStart, now)) {
          scenes.push(accepted);
          continue;
        }
        const cached = states.get(record.videoId);
        if (
          cached?.status === "accepted" &&
          cached.scene &&
          withinWindow(String(cached.scene.releaseDate), windowStart, now)
        ) {
          scenes.push(cached.scene);
          continue;
        }
        if (cached?.status === "pending") undecided += 1;
      }
      if (!store) undecided += classifiedPending + inWindowIds.length - due.length;
      const pending = store ? await store.countFc2Pending() : undecided;
      const deferred = store ? pending : undecided;
      const verifiedEmpty = scenes.length === 0 && deferred === 0 && !walk.edgeStop;
      ctx.log("fc2: walk finished", {
        pages: walk.pages,
        candidates: walk.records.length,
        checked,
        retired,
        pending,
        scenes: scenes.length,
        verifiedEmpty,
      });
      return {
        scenes,
        verifiedEmpty,
        ...(excludedSceneIds.size ? { excludedSceneIds: [...excludedSceneIds] } : {}),
      };
    },
  };
}
