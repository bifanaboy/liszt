/**
 * The eporner trusted-pool index - rung 1 of the ladder, and therefore the hot
 * path.
 *
 * The inherited design (per-scene profile walks, up to 40 pages per scene,
 * cached on `(account, releaseDate)`) is structurally unusable as rung 1: the
 * cache key never hits across scenes with different release dates, and every
 * page walk hydrated every video through `video/id`. This module replaces it
 * with a PERSISTED INDEX in `pool_videos`:
 *
 *   per run, per account - walk `profile/<account>/uploaded-videos/` newest
 *     first, fetching only pages newer than that account's `MAX(added)`, and
 *     stop at the window bound. A weekly full re-walk corrects drift and
 *     deletions.
 *   per scene - narrow the index to the duration band, hydrate only those
 *     survivors through `video/id`, and apply the full gate (duration AND
 *     upload window) to what comes back. The duration and the date are BOTH
 *     persisted by hydration, so a video is hydrated once, not once per scene
 *     per poll.
 *
 * A NOTE ON THE PROFILE LISTING, MEASURED LIVE rather than assumed. Each card
 * is `<div class="mb">` holding an anchor `href="/video-<id>/<slug>/"` whose
 * `<img alt>` and `<p class="mbtit">` both carry the TITLE, and a
 * `<p class="mbstats">` whose `mbtim` span carries the DURATION as `MM:SS`. There
 * is NO upload date anywhere in the listing.
 *
 * That shapes this module in two ways:
 *  - The listing supplies the duration, so the pre-filter runs the duration half
 *    of the gate at zero network cost.
 *  - The date is available ONLY from `video/id`. Measured live: that endpoint
 *    answered with a parseable `added` for 12 of 12 probes. It is the one place
 *    the date enters the index, and `setPoolHydration` writes it there so the
 *    cost is once per video rather than once per scene.
 *  - Without dates in the listing, the incremental walk stops on "this page
 *    added no new ids" (the listing is newest-first, so a page of known ids
 *    means the walk has passed everything that changed), and the weekly full
 *    re-walk corrects deletions by ABSENCE rather than by date.
 *
 * The unknown-date path is strictly more expensive, never less safe: a video the
 * API dates no further than a listing walk is examined like any other, and a
 * video it cannot date at all is rejected by the gate and counted in
 * `PoolMatch.unknownDate` rather than passed.
 */
import {
  calendarDateUtc,
  parseTimestamp,
  pickMatch,
  withinDateWindow,
  type IdentityTier,
  type TubeCandidate,
} from "../core/matching.ts";
import { createExpiringCache, epornerEmbedUrl, epornerVideoId, epornerWatchUrl, validEpornerEmbedUrl, validEpornerUrl, type EpornerVideo } from "./eporner.ts";
import { classifyError } from "../core/fetcher.ts";
import type { PoolVideo, SqliteStore } from "../core/store/sqlite.ts";
import type { Fetcher } from "../sources/types.ts";
import type { MatchScene } from "./types.ts";

const PROFILE_BASE = "https://www.eporner.com/profile";
const DAY_MS = 86_400_000;
const MAX_PAGES = 60;
const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

export interface ProfileEntry {
  id: string;
  title: string | null;
  added: string | null;
  durationSec: number | null;
}

/** `35:38` -> 2138, `1:23:45` -> 5025. Null when the card carries no duration. */
export function parseClockDuration(value: string | null | undefined): number | null {
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/);
  if (!match) return null;
  const [, first, second, third] = match as unknown as [string, string, string, string | undefined];
  const seconds = third === undefined
    ? Number(first) * 60 + Number(second)
    : Number(first) * 3600 + Number(second) * 60 + Number(third);
  return seconds > 0 ? seconds : null;
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse a date out of a card's text, absolute or relative.
 *
 * The absolute forms are rejected on two counts, both measured reaching here
 * from the mojibake'd trusted-pool titles, whose digit runs look exactly like
 * dates:
 *
 *  - Not a real calendar date. A live card read `2026-19-07` - month 19 - and
 *    `Date.UTC` turned it into a confident `2027-07-07` rather than failing.
 *  - In the FUTURE. A card can legitimately be undated, but a video cannot have
 *    been uploaded after `now`, and the mojibake yields real-looking forward
 *    dates too.
 *
 * Both failures are the same class of harm, and it is a serious one rather than
 * a cosmetic one: `poolWatermark` is `MAX(added)`, so a single plausible-looking
 * future date puts the watermark ahead of every real upload, and the
 * incremental walk then stops on its first page forever - silently freezing the
 * index and starving the pool rung of new candidates. One such row also hands
 * the gate a confident wrong date instead of an honest "unknown".
 *
 * An unusable date is null, and null is already an ordinary handled state.
 */
export function parseCardDate(text: string, now: Date): string | null {
  /** A real, already-past calendar date as `YYYY-MM-DD`; null otherwise. */
  const accepted = (year: number, month: number, day: number): string | null => {
    if (calendarDateUtc(year, month, day) === null) return null;
    const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // A video cannot have been uploaded after `now`.
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
    const month = MONTHS[(named[1] as string).slice(0, 3).toLowerCase()];
    if (month !== undefined) {
      const acceptedDate = accepted(Number(named[3]), month + 1, Number(named[2]));
      if (acceptedDate) return acceptedDate;
    }
  }

  const relative = text.match(
    /\b(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago\b/i,
  );
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] as string).toLowerCase();
    const scale = unit === "second" ? 1000 : unit === "minute" ? 60_000 : unit === "hour" ? 3_600_000 : unit === "day" ? DAY_MS : unit === "week" ? 7 * DAY_MS : unit === "month" ? 30 * DAY_MS : 365 * DAY_MS;
    return new Date(now.getTime() - amount * scale).toISOString();
  }
  return null;
}

/**
 * Extract `(id, title, added, durationSec)` from one profile listing page.
 *
 * THROWN WHEN the page yields no video links at all: that is a shape change, and
 * a shape change must be loud rather than looking like an account that stopped
 * uploading.
 *
 * A card is structured as `<div class="mb">` holding an anchor
 * `href="/video-<id>/<slug>/"` whose `<img alt>` and `<p class="mbtit">` both
 * carry the title, plus a `<p class="mbstats">` whose `mbtim` span carries
 * `MM:SS` (or `H:MM:SS`) duration. There is NO upload date on the listing, so
 * `added` stays null and the date half of the gate cannot run until `video/id`
 * hydration supplies one (see the module note). Missing titles and durations are
 * tolerated per card.
 */
export function parseProfileListing(html: string, now: Date): ProfileEntry[] {
  const source = String(html);
  const anchor =
    /<a\b[^>]*href=["'][^"']*\/(?:video-|hd-porn\/)([A-Za-z0-9]+)[^"']*["'][^>]*>([\s\S]{0,600}?)<\/a>/g;
  const byId = new Map<string, ProfileEntry>();
  let match: RegExpExecArray | null;
  let sawLink = false;

  while ((match = anchor.exec(source)) !== null) {
    const id = match[1] as string;
    if (byId.has(id)) continue;
    sawLink = true;
    const tag = match[0];
    const inner = match[2] as string;

    let title =
      stripTags(inner) ||
      stripTags(tag.match(/alt=["']([^"']+)["']/i)?.[1] ?? "") ||
      stripTags(tag.match(/title=["']([^"']+)["']/i)?.[1] ?? "");
    if (/^(?:watch|video|eporner|hd)$/i.test(title)) title = "";

    // The card's meta line sits after the anchor, so read a slice of HTML that
    // starts here. The duration is a `title="Duration"` span holding `MM:SS`.
    const slice = source.slice(match.index, match.index + 1200);
    const durationSec = parseClockDuration(
      slice.match(/title=["']Duration["'][^>]*>([^<]+)</i)?.[1] ?? null,
    );
    // A date is best-effort: the live listing carries none, but if one ever
    // appears we still capture it rather than discarding the evidence.
    const added = parseCardDate(stripTags(slice), now);

    byId.set(id, { id, title: title || null, added, durationSec });
  }
  if (!sawLink) throw new Error("eporner profile listing contained no video links (shape change?)");
  return [...byId.values()];
}

/**
 * The listing page URL for an account and page number.
 *
 * PAGINATION IS PATH-BASED. Verified live: `/uploaded-videos/2/` returns page 2,
 * while `/uploaded-videos/?page=2` answers `301` back to page 1. Using the query
 * form therefore caps the whole index at the first page - measured here, not
 * assumed.
 */
export function profileListingUrl(account: string, page = 1): string {
  const base = `${PROFILE_BASE}/${encodeURIComponent(account)}/uploaded-videos/`;
  return page > 1 ? `${base}${page}/` : base;
}

export const POOL_FULL_REWALK_KEY = "pool:last-full-rewalk";

export interface PoolIndexDeps {
  store: SqliteStore;
  fetcher: Fetcher;
  now: Date;
  uploaders: readonly string[];
  /** The rolling window; the index stops at its start. */
  windowDays: number;
  /** Extra days indexed below the window, so a late run still has headroom. */
  marginDays?: number;
  /** Days between full re-walks. Incremental walks skip this check. */
  fullRewalkDays: number;
  log(message: string, fields?: Record<string, unknown>): void;
  maxPages?: number;
}

export interface UploaderIndexReport {
  uploader: string;
  pagesFetched: number;
  indexed: number;
  undated: number;
  watermark: string | null;
  fullRewalk: boolean;
  pruned: number;
  /** True when the walk stopped on a 404, i.e. it reached the end of the list. */
  endOfListing: boolean;
  error?: string;
}

export interface PoolIndexReport {
  uploaders: UploaderIndexReport[];
  totalIndexed: number;
  totalUndated: number;
  /** True when every account's walk completed. */
  ok: boolean;
}

/** The instant a listing's `added` timestamp is truncated to a day. */
function timeOf(iso: string | null): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

/** True when a full re-walk is due: never run, or older than the cadence. */
export function fullRewalkDue(
  lastFullRewalkAt: string | null,
  now: Date,
  fullRewalkDays: number,
): boolean {
  const last = Date.parse(lastFullRewalkAt ?? "");
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= fullRewalkDays * DAY_MS;
}

/**
 * Refresh the pool index. Incremental per account, with a full re-walk when
 * one is due. A failure in one account is isolated: the others still index, and
 * the report says which failed - an account that errors did NOT "find nothing".
 */
export async function indexPool(deps: PoolIndexDeps): Promise<PoolIndexReport> {
  const { store, fetcher, now, uploaders, windowDays, fullRewalkDays, log } = deps;
  const marginDays = deps.marginDays ?? 7;
  const maxPages = deps.maxPages ?? MAX_PAGES;
  const windowStartMs = now.getTime() - windowDays * DAY_MS - marginDays * DAY_MS;
  const cache = createExpiringCache({ ttlMs: 60_000 });
  const lastFullWalk = store.getPoolMeta(POOL_FULL_REWALK_KEY);
  const reports: UploaderIndexReport[] = [];

  for (const uploader of uploaders) {
    const report: UploaderIndexReport = {
      uploader,
      pagesFetched: 0,
      indexed: 0,
      undated: 0,
      watermark: store.poolWatermark(uploader),
      fullRewalk: false,
      pruned: 0,
      endOfListing: false,
    };
    reports.push(report);
    try {
      const watermark = store.poolWatermark(uploader);
      const watermarkMs = timeOf(watermark);
      const fullRewalk = fullRewalkDue(lastFullWalk, now, fullRewalkDays) || !Number.isFinite(watermarkMs);
      report.fullRewalk = fullRewalk;

      const seen = new Set<string>();
      for (let page = 1; page <= maxPages; page += 1) {
        const url = profileListingUrl(uploader, page);
        let entries: ProfileEntry[];
        try {
          const html = await cache(url, () => fetcher.text(url, { headers: { accept: "text/html" } }));
          report.pagesFetched += 1;
          entries = parseProfileListing(html, now);
        } catch (error) {
          // Walking off the end of the listing is a 404, and that is the normal
          // way a newest-first walk terminates - it is NOT an account failure.
          // Anything else (timeout, 403, 5xx, a shape change) is a real failure
          // and must surface as one, or a broken account would look healthy.
          if (classifyError(error) === "definitive") {
            report.endOfListing = true;
            break;
          }
          throw error;
        }
        if (!entries.length) break;

        let oldest = Number.POSITIVE_INFINITY;
        let newRows = 0;
        for (const entry of entries) {
          const addedMs = timeOf(entry.added);
          oldest = Math.min(oldest, addedMs);
          seen.add(entry.id);
          if (!store.poolVideoExists(entry.id, uploader)) newRows += 1;
          // A dated row outside the window is not indexed. An UNDATED row is
          // kept regardless: it cannot be date-narrowed, so dropping it would
          // silently discard the only evidence it has.
          if (entry.added !== null && addedMs < windowStartMs) continue;
          store.upsertPoolVideo({
            id: entry.id,
            uploader,
            title: entry.title,
            added: entry.added,
            // The listing already carries the duration, so the row is hydrated
            // at index time and no per-scene `video/id` call is ever needed.
            durationSec: entry.durationSec,
            hydratedAt: entry.durationSec === null ? null : now.toISOString(),
          });
          report.indexed += 1;
          if (entry.added === null) report.undated += 1;
        }

        // Page-level stop, in order of confidence:
        //  - a page that added nothing new means the newest-first listing has
        //    been walked past the end of what changed. This is the stop that
        //    works even though the listing carries no dates.
        //  - everything dated on this page predates the window, or (on an
        //    incremental walk) predates the account's own watermark.
        if (newRows === 0 && !fullRewalk) break;
        const stopAtWindow = oldest < windowStartMs;
        const stopAtWatermark = !fullRewalk && oldest <= watermarkMs;
        if (stopAtWindow || stopAtWatermark) break;
        if (entries.length < 12) break;
      }

      if (fullRewalk) {
        // The re-walk is what corrects deletions and drift. Because the listing
        // carries no dates, correctness comes from ABSENCE: a row the walk did
        // not see has been deleted upstream. The date-keyed prune is kept for
        // any row that did acquire a date, so both paths stay honest.
        report.pruned =
          store.prunePoolMissing(uploader, seen) +
          store.prunePoolUploader(uploader, new Date(windowStartMs).toISOString());
      }
      report.watermark = store.poolWatermark(uploader);
    } catch (error) {
      // One unavailable profile must not hide the other accounts.
      report.error = (error as Error).message;
      log("eporner pool index: account failed", {
        uploader,
        error: report.error,
        definitive: classifyError(error) === "definitive",
      });
    }
  }

  if (reports.every((report) => !report.error)) {
    store.setPoolMeta(POOL_FULL_REWALK_KEY, now.toISOString());
  }
  return {
    uploaders: reports,
    totalIndexed: reports.reduce((total, entry) => total + entry.indexed, 0),
    totalUndated: reports.reduce((total, entry) => total + entry.undated, 0),
    ok: reports.every((report) => !report.error),
  };
}

export interface PoolLookupOptions {
  store: SqliteStore;
  fetcher: Fetcher;
  uploaders: readonly string[];
  /** Duration gate, applied identically on every rung. */
  durationToleranceSec: number;
  /** Upload window. Null disables the date half, for a stage that has no date. */
  dateWindowDays: number | null;
  log(message: string, fields?: Record<string, unknown>): void;
  /** Bound the per-scene hydration fan-out. */
  maxHydrations?: number;
  /** Bound the rows examined per account, newest first. */
  maxConsidered?: number;
}

/** Why the pool rung produced no link. Recorded, not swallowed. */
export type PoolRejection = "duration" | "date" | "none";

export interface PoolMatch {
  url: string;
  embedUrl: string;
  videoId: string;
  uploader: string;
  title: string;
  /** The winner's identity tier. 0 means it won on views alone. */
  identityTier: IdentityTier;
  /** Days between the scene's release date and the winner's upload date. */
  lagDays: number | null;
  /** Index rows the duration pre-filter examined for this scene. */
  candidatesConsidered: number;
  /** Rows that survived the duration band. */
  durationPassed: number;
  /** Hydrated candidates, before the date half. */
  hydrated: number;
  /** Survivors rejected by the date half as out-of-window. */
  rejectedByDate: number;
  /** Survivors whose upload date could not be read at all. */
  unknownDate: number;
  /** True when the hydration cap dropped otherwise-qualifying survivors. */
  hydrationCapped: boolean;
  /** Set when the rung found nothing; null when it linked. */
  rejected: PoolRejection | null;
}

/**
 * The pre-filter: the DURATION half of the gate, run at zero network cost
 * against the index.
 *
 * It is the duration half and ONLY the duration half. The date half cannot run
 * here: the profile listing carries a title and an `MM:SS` duration but no
 * upload date, so a row's date is either unknown or already persisted from an
 * earlier hydration. Rows whose date is already stored are narrowed in SQL;
 * everything else is examined and left to `createPoolLookup` to reject after
 * hydration.
 *
 * The old title-identity pre-filter is deliberately gone. It was what made
 * hydration cheap, and it is also exactly what the identity-as-ranking-signal
 * change retires - filtering on identity here would re-introduce the gate the
 * plan removed, one rung earlier. The cost is bounded and was measured rather
 * than assumed: over 1,005 indexed pool videos the +-2s band holds a mean of
 * 3.1 videos, a median of 2, a p99 of 10 and a maximum of 13, so the survivor
 * set stays well inside the `maxHydrations` cap.
 */
export function preFilter(
  scene: MatchScene,
  video: PoolVideo,
  { durationToleranceSec }: { durationToleranceSec?: number } = {},
): boolean {
  if (!video.title) return false;
  if (
    durationToleranceSec !== undefined &&
    video.durationSec !== null &&
    Math.abs(video.durationSec - (scene.durationSec ?? 0)) > durationToleranceSec
  ) {
    return false;
  }
  return true;
}

async function hydrate(
  video: PoolVideo,
  { store, fetcher, now }: { store: SqliteStore; fetcher: Fetcher; now: Date },
): Promise<EpornerVideo | null> {
  // The short-circuit needs BOTH halves of the gate on hand. A row with a
  // duration but no date is exactly the common case - the listing supplies one
  // and never the other - and returning it here would leave it permanently
  // undatable, so every scene that considers it would silently find an
  // inadmissible candidate forever.
  if (video.durationSec !== null && video.added !== null) {
    return {
      id: video.id,
      title: video.title ?? "",
      url: epornerWatchUrl(video.id),
      embed: epornerEmbedUrl(video.id),
      length_sec: video.durationSec,
      added: video.added,
      uploader: video.uploader,
    };
  }
  const url = new URL("https://www.eporner.com/api/v2/video/id/");
  url.searchParams.set("id", video.id);
  url.searchParams.set("format", "json");
  try {
    const data = await fetcher.json<unknown>(url.href, { headers: { accept: "application/json" } });
    const record = (Array.isArray(data) ? data[0] : data) as EpornerVideo | undefined;
    const duration = Number(record?.length_sec);
    if (!record || !Number.isFinite(duration) || duration <= 0) return null;
    // Persist permanently, and persist the DATE with it: hydration happens once
    // per video, not once per scene, and the date is half the gate. Dropping it
    // here - as an earlier version did - would make every later scene pay the
    // same request again to learn the same thing.
    store.setPoolHydration(
      video.id,
      video.uploader,
      Math.round(duration),
      record.added ?? null,
      now.toISOString(),
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
    // A missing post must not hide the other candidates.
    return null;
  }
}

/** What the duration pre-filter and hydration produced, before the date half. */
export interface PoolSurvivors {
  /** Index rows the duration pre-filter examined. */
  considered: number;
  /** Rows that survived the duration band. */
  durationPassed: number;
  /** Hydrated candidates, ready for the date half. */
  candidates: TubeCandidate[];
  /** True when the hydration cap dropped survivors that would otherwise qualify. */
  capped: boolean;
}

export interface PoolGatherDeps {
  store: SqliteStore;
  fetcher: Fetcher;
  uploaders: readonly string[];
  durationToleranceSec: number;
  dateWindowDays: number | null;
  log(message: string, fields?: Record<string, unknown>): void;
  maxHydrations?: number;
  maxConsidered?: number;
}

/**
 * Everything in the pool rung that happens BEFORE the date half: scan the
 * index, apply the duration band, hydrate the survivors.
 *
 * Split out and exported because calibration needs to see this set in full. The
 * lag histogram has to be computed over every duration-surviving candidate, not
 * only over the ones that won - a histogram of the winners cannot show the
 * tail the window is meant to cut off, and would quietly justify whatever value
 * the window already has.
 */
export async function gatherPoolSurvivors(
  scene: MatchScene,
  deps: PoolGatherDeps,
  now: Date,
): Promise<PoolSurvivors> {
  const { store, fetcher, uploaders, durationToleranceSec, dateWindowDays, log } = deps;
  const maxHydrations = deps.maxHydrations ?? 40;
  /** Bound the rows examined per account, newest first. */
  const maxConsidered = deps.maxConsidered ?? 750;

  const releaseMs = Date.parse(scene.releaseDate);
  // The SQL narrowing is a symmetric superset of the real asymmetric window,
  // widened by the 1-day lower margin. It is an optimisation, never the gate:
  // the exact window is applied afterwards, and rows with no stored date are
  // examined here so hydration can supply one.
  const from = new Date(releaseMs - (dateWindowDays ?? 0) * DAY_MS - DAY_MS).toISOString();
  const to = new Date(releaseMs + (dateWindowDays ?? 0) * DAY_MS + DAY_MS).toISOString();

  const survivors: PoolVideo[] = [];
  let considered = 0;
  for (const uploader of uploaders) {
    // Dated rows are narrowed to the window by SQL. The listing normally
    // supplies no date, so the undated rows are the working set: they cannot
    // be date-narrowed, so they are pre-filtered on duration alone. Same gate,
    // more rows examined, no less safety - and the walk that produced them was
    // already newest-first, so the newest rows come first and the cap keeps the
    // scan bounded.
    const dated = store.poolVideosInWindow(uploader, from, to);
    const undated = store.poolVideosUndated(uploader);
    const datedIds = new Set(dated.map((row) => row.id));
    const rows = [...dated, ...undated.filter((row) => !datedIds.has(row.id))];
    let examined = 0;
    for (const row of rows) {
      if (examined >= maxConsidered) break;
      examined += 1;
      considered += 1;
      if (preFilter(scene, row, { durationToleranceSec })) survivors.push(row);
    }
  }
  if (!survivors.length) return { considered, durationPassed: 0, candidates: [], capped: false };

  // Hydration is the only network cost in this rung, and it is bounded.
  const queue = survivors.slice(0, maxHydrations);
  const capped = survivors.length > queue.length;
  if (capped) {
    log("eporner pool: hydration cap reached", {
      scene: scene.id,
      survivors: survivors.length,
      capped: queue.length,
    });
  }
  const hydrated = await Promise.all(queue.map((video) => hydrate(video, { store, fetcher, now })));
  const candidates = hydrated
    .filter(
      (video): video is EpornerVideo =>
        video !== null && validEpornerUrl(video.url) && validEpornerEmbedUrl(video.embed),
    )
    .map((video) => ({
      url: String(video.url ?? ""),
      title: String(video.title ?? ""),
      duration: Number(video.length_sec),
      added: video.added ?? null,
      views: video.views ?? null,
      uploader: video.uploader,
    }));
  return { considered, durationPassed: survivors.length, candidates, capped };
}

/**
 * Build the pool rung. Every scene with a positive duration is eligible; a
 * performer-less scene is eligible too, it simply ranks on one fewer signal.
 */
export function createPoolLookup(options: PoolLookupOptions) {
  const { store, fetcher, uploaders, durationToleranceSec, dateWindowDays, log } = options;

  return async (scene: MatchScene, now: Date): Promise<PoolMatch | null> => {
    if (!Number.isFinite(scene.durationSec) || (scene.durationSec ?? 0) <= 0) return null;
    if (!Number.isFinite(Date.parse(scene.releaseDate))) return null;

    const gathered = await gatherPoolSurvivors(
      scene,
      { store, fetcher, uploaders, durationToleranceSec, dateWindowDays, log },
      now,
    );
    const { candidates, considered, durationPassed } = gathered;
    if (!candidates.length) {
      return {
        ...emptyMatch,
        candidatesConsidered: considered,
        rejected: durationPassed > 0 ? "none" : "duration",
      };
    }

    // The date half, counted as it rejects. A rung that cannot supply dates at
    // all is the failure mode this is here to make visible: the funnel shows an
    // unknown-date count and no links, rather than a silent fall-through to the
    // more expensive rung below that reads as "this scene has no video".
    const window = dateWindowDays;
    const checks =
      window === null
        ? null
        : candidates.map((candidate) => withinDateWindow(scene.releaseDate, candidate.added, window));
    const eligible = checks ? candidates.filter((_, index) => checks[index] === true) : candidates;
    const unknownDate = checks?.filter((check) => check === "unknown").length ?? 0;
    const rejectedByDate = checks ? checks.filter((check) => check === false).length : 0;

    const match = pickMatch(scene, eligible, { durationToleranceSec, dateWindowDays: window });
    const counts = {
      candidatesConsidered: considered,
      durationPassed,
      hydrated: candidates.length,
      rejectedByDate,
      unknownDate,
      hydrationCapped: gathered.capped,
    };
    if (!match) return { ...emptyMatch, ...counts, rejected: "date" };

    const videoId = epornerVideoId(match.candidate.url);
    if (!videoId) return { ...emptyMatch, ...counts, rejected: "none" };
    return {
      url: epornerWatchUrl(videoId),
      embedUrl: epornerEmbedUrl(videoId),
      videoId,
      uploader: String(match.candidate.uploader ?? ""),
      title: match.candidate.title,
      identityTier: match.identityTier,
      lagDays: lagInDays(scene.releaseDate, match.candidate.added),
      ...counts,
      rejected: null,
    };
  };
}

/** Whole days from the release date to the upload date; null if either is unreadable. */
function lagInDays(releaseDate: string, added: string | null | undefined): number | null {
  const release = parseTimestamp(releaseDate);
  const uploaded = parseTimestamp(added);
  if (release === null || uploaded === null) return null;
  return Math.round((uploaded - release) / DAY_MS);
}

/** The zeroed match, for the "the rung found nothing" returns. */
const emptyMatch: PoolMatch = {
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
  rejected: "none",
};
