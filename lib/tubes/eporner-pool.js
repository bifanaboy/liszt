import { calendarDateUtc, parseTimestamp, pickMatch, withinDateWindow } from "../matching.js";
import {
  createExpiringCache,
  epornerEmbedUrl,
  epornerVideoId,
  epornerWatchUrl,
  validEpornerEmbedUrl,
  validEpornerUrl,
} from "./eporner.js";
import { mapIsolated } from "../concurrency.js";
import { classifyError } from "../fetcher.js";
const PROFILE_BASE = "https://www.eporner.com/profile";
const DAY_MS = 86_400_000;
const MAX_PAGES = 60;
const MONTHS = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};
export function parseClockDuration(value) {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  const [, first, second, third] = match;
  const seconds =
    third === undefined
      ? Number(first) * 60 + Number(second)
      : Number(first) * 3600 + Number(second) * 60 + Number(third);
  return seconds > 0 ? seconds : null;
}
function stripTags(value) {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
export function parseCardDate(text, now) {
  const accepted = (year, month, day) => {
    if (calendarDateUtc(year, month, day) === null) return null;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return Date.parse(`${iso}T00:00:00.000Z`) <= now.getTime() ? iso : null;
  };
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const acceptedDate = accepted(Number(iso[1]), Number(iso[2]), Number(iso[3]));
    if (acceptedDate) return acceptedDate;
  }
  const dotted = text.match(/\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/);
  if (dotted) {
    const acceptedDate = accepted(Number(dotted[3]), Number(dotted[2]), Number(dotted[1]));
    if (acceptedDate) return acceptedDate;
  }
  const named = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
  if (named) {
    const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const acceptedDate = accepted(Number(named[3]), month + 1, Number(named[2]));
      if (acceptedDate) return acceptedDate;
    }
  }
  const relative = text.match(/\b(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const scale =
      unit === "second"
        ? 1000
        : unit === "minute"
          ? 60_000
          : unit === "hour"
            ? 3_600_000
            : unit === "day"
              ? DAY_MS
              : unit === "week"
                ? 7 * DAY_MS
                : unit === "month"
                  ? 30 * DAY_MS
                  : 365 * DAY_MS;
    return new Date(now.getTime() - amount * scale).toISOString();
  }
  return null;
}
export function parseProfileListing(html, now) {
  const source = String(html);
  const anchor =
    /<a\b[^>]*href=["'][^"']*\/(?:video-|hd-porn\/)([A-Za-z0-9]+)[^"']*["'][^>]*>([\s\S]{0,600}?)<\/a>/g;
  const byId = new Map();
  let match;
  let sawLink = false;
  while ((match = anchor.exec(source)) !== null) {
    const id = match[1];
    if (byId.has(id)) continue;
    sawLink = true;
    const tag = match[0];
    const inner = match[2];
    let title =
      stripTags(inner) ||
      stripTags(tag.match(/alt=["']([^"']+)["']/i)?.[1] ?? "") ||
      stripTags(tag.match(/title=["']([^"']+)["']/i)?.[1] ?? "");
    if (/^(?:watch|video|eporner|hd)$/i.test(title)) title = "";
    const cardStart = match.index;
    const nextCard = source.indexOf('<div class="video_container', cardStart + 1);
    const sliceEnd =
      nextCard === -1 ? Math.min(source.length, cardStart + CARD_SLICE_CHARS) : nextCard;
    const slice = source.slice(cardStart, sliceEnd);
    const durationSec = parseClockDuration(
      slice.match(/title=["']Duration["'][^>]*>([^<]+)/i)?.[1] ?? null,
    );
    const added = parseCardDate(stripTags(slice), now);
    byId.set(id, { id, title: title || null, added, durationSec });
  }
  if (!sawLink) throw new Error("eporner profile listing contained no video links (shape change?)");
  return [...byId.values()];
}
export function profileListingUrl(account, page = 1) {
  const base = `${PROFILE_BASE}/${encodeURIComponent(account)}/uploaded-videos/`;
  return page > 1 ? `${base}${page}/` : base;
}
export const POOL_FULL_REWALK_KEY = "pool:last-full-rewalk";
const CARD_SLICE_CHARS = 1200;
function timeOf(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}
export function fullRewalkDue(lastFullRewalkAt, now, fullRewalkDays) {
  const last = Date.parse(lastFullRewalkAt ?? "");
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= fullRewalkDays * DAY_MS;
}
export async function indexPool(deps) {
  const { store, fetcher, now, uploaders, windowDays, fullRewalkDays, log } = deps;
  const marginDays = deps.marginDays ?? 7;
  const maxPages = deps.maxPages ?? MAX_PAGES;
  const windowStartMs = now.getTime() - windowDays * DAY_MS - marginDays * DAY_MS;
  const cache = createExpiringCache({ ttlMs: 60_000 });
  const lastFullWalk = await store.getPoolMeta(POOL_FULL_REWALK_KEY);
  const reports = [];
  for (const uploader of uploaders) {
    const report = {
      uploader,
      pagesFetched: 0,
      indexed: 0,
      undated: 0,
      watermark: await store.poolWatermark(uploader),
      fullRewalk: false,
      pruned: 0,
      endOfListing: false,
    };
    reports.push(report);
    try {
      const watermark = await store.poolWatermark(uploader);
      const watermarkMs = timeOf(watermark);
      const fullRewalk =
        fullRewalkDue(lastFullWalk, now, fullRewalkDays) || !Number.isFinite(watermarkMs);
      report.fullRewalk = fullRewalk;
      const seen = new Set();
      let reachedEnd = false;
      let pageSize = 0;
      for (let page = 1; page <= maxPages; page += 1) {
        const url = profileListingUrl(uploader, page);
        let entries;
        try {
          const html = await cache(url, () =>
            fetcher.text(url, { headers: { accept: "text/html" } }),
          );
          report.pagesFetched += 1;
          entries = parseProfileListing(html, now);
        } catch (error) {
          if (classifyError(error) === "definitive") {
            reachedEnd = true;
            break;
          }
          throw error;
        }
        if (!entries.length) {
          reachedEnd = true;
          break;
        }
        if (page === 1) pageSize = entries.length;
        let oldest = Number.POSITIVE_INFINITY;
        let newRows = 0;
        for (const entry of entries) {
          const addedMs = timeOf(entry.added);
          oldest = Math.min(oldest, addedMs);
          seen.add(entry.id);
          if (!(await store.poolVideoExists(entry.id, uploader))) newRows += 1;
          if (entry.added !== null && addedMs < windowStartMs) continue;
          await store.upsertPoolVideo({
            id: entry.id,
            uploader,
            title: entry.title,
            added: entry.added,
            durationSec: entry.durationSec,
            hydratedAt: entry.durationSec === null ? null : now.toISOString(),
            views: null,
          });
          report.indexed += 1;
          if (entry.added === null) report.undated += 1;
        }
        if (newRows === 0 && !fullRewalk) break;
        const stopAtWindow = oldest < windowStartMs;
        const stopAtWatermark = !fullRewalk && oldest <= watermarkMs;
        if (stopAtWindow || stopAtWatermark) break;
        if (pageSize > 0 && entries.length < pageSize) {
          reachedEnd = true;
          break;
        }
      }
      report.endOfListing = reachedEnd;
      if (fullRewalk) {
        if (reachedEnd) {
          report.pruned =
            (await store.prunePoolMissing(uploader, seen)) +
            (await store.prunePoolUploader(uploader, new Date(windowStartMs).toISOString()));
        } else {
          report.pruneSkipped = true;
          log("eporner pool: re-walk truncated, skipping the absence prune", {
            uploader,
            pagesFetched: report.pagesFetched,
            seen: seen.size,
          });
        }
      }
      report.watermark = await store.poolWatermark(uploader);
    } catch (error) {
      report.error = error.message;
      log("eporner pool index: account failed", {
        uploader,
        error: report.error,
        definitive: classifyError(error) === "definitive",
      });
    }
    deps.onUploader?.(reports.length, uploaders.length, uploader);
  }
  const rewalked = reports.filter((report) => report.fullRewalk);
  if (rewalked.length && rewalked.every((report) => !report.error && report.endOfListing)) {
    await store.setPoolMeta(POOL_FULL_REWALK_KEY, now.toISOString());
  }
  return {
    uploaders: reports,
    totalIndexed: reports.reduce((total, entry) => total + entry.indexed, 0),
    totalUndated: reports.reduce((total, entry) => total + entry.undated, 0),
    ok: reports.every((report) => !report.error),
  };
}
export function preFilter(scene, video, { durationToleranceSec } = {}) {
  if (!video.title) return false;
  if (
    durationToleranceSec !== undefined &&
    video.durationSec !== null &&
    (scene.durationRange
      ? Math.max(
          scene.durationRange.minSec - video.durationSec,
          0,
          video.durationSec - scene.durationRange.maxSec,
        )
      : Math.abs(video.durationSec - (scene.durationSec ?? 0))) > durationToleranceSec
  ) {
    return false;
  }
  return true;
}
async function hydrate(video, { store, fetcher, now }) {
  if (video.durationSec !== null && video.added !== null && video.views !== null) {
    return {
      id: video.id,
      title: video.title ?? "",
      url: epornerWatchUrl(video.id),
      embed: epornerEmbedUrl(video.id),
      length_sec: video.durationSec,
      added: video.added,
      views: video.views,
      uploader: video.uploader,
    };
  }
  const url = new URL("https://www.eporner.com/api/v2/video/id/");
  url.searchParams.set("id", video.id);
  url.searchParams.set("format", "json");
  try {
    const data = await fetcher.json(url.href, { headers: { accept: "application/json" } });
    const record = Array.isArray(data) ? data[0] : data;
    const duration = Number(record?.length_sec);
    if (!record || !Number.isFinite(duration) || duration <= 0) return null;
    const views = comparableViews(record.views);
    await store.setPoolHydration(
      video.id,
      video.uploader,
      Math.round(duration),
      record.added ?? null,
      now.toISOString(),
      views,
    );
    return {
      id: video.id,
      title: record.title || video.title || "",
      url: epornerWatchUrl(video.id),
      embed: epornerEmbedUrl(video.id),
      length_sec: Math.round(duration),
      added: record.added ?? video.added ?? undefined,
      views: record.views,
      uploader: video.uploader,
    };
  } catch {
    return null;
  }
}
function comparableViews(raw) {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const suffix = /(k|m)$/i.exec(trimmed);
  const digits = trimmed.replace(/[,\s]/g, "").replace(/(?:views?|k|m)$/i, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  if (suffix) return value * (/^m$/i.test(suffix[1]) ? 1_000_000 : 1_000);
  return value;
}
const POOL_HYDRATION_CONCURRENCY = 4;
const poolProgressTimes = new WeakMap();
async function nextPoolProgressAt(now, store) {
  let previous = poolProgressTimes.get(store);
  if (previous === undefined) {
    const persisted = await store.latestPoolProgressAt();
    previous = persisted === null ? -Infinity : Date.parse(persisted);
  }
  previous = Math.max(previous, poolProgressTimes.get(store) ?? -Infinity);
  const next = Math.max(now.getTime(), previous + 1);
  poolProgressTimes.set(store, next);
  return new Date(next).toISOString();
}
export async function gatherPoolSurvivors(scene, deps, now) {
  const { store, fetcher, uploaders, durationToleranceSec, dateWindowDays, log } = deps;
  const maxHydrations = deps.maxHydrations ?? 40;
  const maxConsidered = deps.maxConsidered ?? 750;
  const releaseMs = Date.parse(scene.releaseDate);
  const from = new Date(releaseMs - (dateWindowDays ?? 0) * DAY_MS - DAY_MS).toISOString();
  const to = new Date(releaseMs + (dateWindowDays ?? 0) * DAY_MS + DAY_MS).toISOString();
  const survivors = [];
  let considered = 0;
  const band = scene.durationRange
    ? {
        durationSec: (scene.durationRange.minSec + scene.durationRange.maxSec) / 2,
        toleranceSec:
          (scene.durationRange.maxSec - scene.durationRange.minSec) / 2 + durationToleranceSec,
      }
    : typeof scene.durationSec === "number" && Number.isFinite(scene.durationSec)
      ? { durationSec: scene.durationSec, toleranceSec: durationToleranceSec }
      : undefined;
  for (const uploader of uploaders) {
    const dated = band
      ? await store.poolVideosInWindow(uploader, from, to, band)
      : await store.poolVideosInWindow(uploader, from, to);
    const undated = await store.poolVideosUndated(uploader, maxConsidered);
    const datedIds = new Set(dated.map((row) => row.id));
    const rows = [...dated, ...undated.filter((row) => !datedIds.has(row.id))];
    let examined = 0;
    for (const row of rows) {
      if (examined >= maxConsidered) break;
      examined += 1;
      considered += 1;
      if (preFilter(scene, row, { durationToleranceSec })) {
        survivors.push(row);
      } else if (row.added === null) {
        await store.markPoolUndatedScan(row.id, row.uploader, await nextPoolProgressAt(now, store));
      }
    }
  }
  const survivorDurations = survivors.flatMap((row) =>
    row.durationSec === null ? [] : [row.durationSec],
  );
  if (!survivors.length)
    return { considered, durationPassed: 0, survivorDurations, candidates: [], capped: false };
  survivors.sort((a, b) =>
    (a.hydrationAttemptedAt ?? "").localeCompare(b.hydrationAttemptedAt ?? ""),
  );
  const queue = survivors.slice(0, maxHydrations);
  const capped = survivors.length > queue.length;
  if (capped) {
    log("eporner pool: hydration cap reached", {
      scene: scene.id,
      survivors: survivors.length,
      hydrated: queue.length,
      omittedCandidates: survivors.length - queue.length,
    });
  }
  const hydrated = await mapIsolated(
    queue,
    async (video) => {
      await store.markPoolHydrationAttempt(
        video.id,
        video.uploader,
        await nextPoolProgressAt(now, store),
      );
      return hydrate(video, { store, fetcher, now });
    },
    POOL_HYDRATION_CONCURRENCY,
  );
  const candidates = hydrated
    .filter(
      (video) => video !== null && validEpornerUrl(video.url) && validEpornerEmbedUrl(video.embed),
    )
    .map((video) => ({
      url: String(video.url ?? ""),
      title: String(video.title ?? ""),
      duration: Number(video.length_sec),
      added: video.added ?? null,
      views: video.views ?? null,
      uploader: video.uploader,
    }));
  return { considered, durationPassed: survivors.length, survivorDurations, candidates, capped };
}
export function createPoolLookup(options) {
  const { store, fetcher, uploaders, durationToleranceSec, dateWindowDays, log } = options;
  return async (scene, now) => {
    if (
      scene.durationReview ||
      ((!Number.isFinite(scene.durationSec) || (scene.durationSec ?? 0) <= 0) &&
        !scene.durationRange)
    )
      return null;
    if (!Number.isFinite(Date.parse(scene.releaseDate))) return null;
    const gathered = await gatherPoolSurvivors(
      scene,
      {
        store,
        fetcher,
        uploaders,
        durationToleranceSec,
        dateWindowDays,
        log,
        ...(options.maxHydrations !== undefined ? { maxHydrations: options.maxHydrations } : {}),
        ...(options.maxConsidered !== undefined ? { maxConsidered: options.maxConsidered } : {}),
      },
      now,
    );
    const { candidates, considered, durationPassed } = gathered;
    if (!candidates.length) {
      return {
        ...emptyMatch,
        candidatesConsidered: considered,
        hydrationCapped: gathered.capped,
        omittedCandidates: Math.max(0, durationPassed - (options.maxHydrations ?? 40)),
        rejected: gathered.capped ? "incomplete" : durationPassed > 0 ? "none" : "duration",
      };
    }
    const window = dateWindowDays;
    const checks =
      window === null
        ? null
        : candidates.map((candidate) =>
            withinDateWindow(scene.releaseDate, candidate.added, window),
          );
    const eligible = checks ? candidates.filter((_, index) => checks[index] === true) : candidates;
    const unknownDate = checks?.filter((check) => check === "unknown").length ?? 0;
    const rejectedByDate = checks ? checks.filter((check) => check === false).length : 0;
    const match = pickMatch(scene, eligible, {
      durationToleranceSec,
      dateWindowDays: window,
      requireIdentity: true,
    });
    const counts = {
      candidatesConsidered: considered,
      durationPassed,
      hydrated: candidates.length,
      rejectedByDate,
      unknownDate,
      hydrationCapped: gathered.capped,
      omittedCandidates: Math.max(0, durationPassed - (options.maxHydrations ?? 40)),
    };
    if (!match)
      return {
        ...emptyMatch,
        ...counts,
        fallbackCandidates: eligible,
        rejected: gathered.capped ? "incomplete" : eligible.length ? "none" : "date",
      };
    const videoId = epornerVideoId(match.candidate.url);
    if (!videoId)
      return {
        ...emptyMatch,
        ...counts,
        fallbackCandidates: eligible,
        rejected: "none",
      };
    return {
      url: epornerWatchUrl(videoId),
      embedUrl: epornerEmbedUrl(videoId),
      videoId,
      uploader: String(match.candidate.uploader ?? ""),
      title: match.candidate.title,
      identityTier: match.identityTier,
      lagDays: lagInDays(scene.releaseDate, match.candidate.added),
      ...counts,
      fallbackCandidates: eligible,
      rejected: null,
    };
  };
}
function lagInDays(releaseDate, added) {
  const release = parseTimestamp(releaseDate);
  const uploaded = parseTimestamp(added);
  if (release === null || uploaded === null) return null;
  return Math.round((uploaded - release) / DAY_MS);
}
const emptyMatch = {
  url: "",
  embedUrl: "",
  videoId: "",
  uploader: "",
  title: "",
  identityTier: 0,
  lagDays: null,
  candidatesConsidered: 0,
  durationPassed: 0,
  hydrated: 0,
  rejectedByDate: 0,
  unknownDate: 0,
  hydrationCapped: false,
  omittedCandidates: 0,
  fallbackCandidates: [],
  rejected: "none",
};
