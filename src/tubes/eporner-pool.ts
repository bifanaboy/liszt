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
import {
  createExpiringCache,
  epornerEmbedUrl,
  epornerVideoId,
  epornerWatchUrl,
  validEpornerEmbedUrl,
  validEpornerUrl,
  type EpornerVideo,
} from "./eporner.ts";
import { mapIsolated } from "../core/concurrency.ts";
import { classifyError } from "../core/fetcher.ts";
import type { PoolVideo, SqliteStore } from "../core/store/sqlite.ts";
import type { Fetcher } from "../sources/types.ts";
import type { MatchScene } from "./types.ts";

const PROFILE_BASE = "https://www.eporner.com/profile";
const DAY_MS = 86_400_000;
const MAX_PAGES = 60;
const MONTHS: Record<string, number> = {
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
  const seconds =
    third === undefined
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

  const relative = text.match(/\b(\d+)\s*(second|minute|hour|day|week|month|year)s?\s*ago\b/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = (relative[2] as string).toLowerCase();
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

    // The card's meta line sits after the anchor, so a slice of HTML starting
    // here is needed to reach it. The slice is TRUNCATED AT THE NEXT CARD
    // first: the duration span belongs to this card, but a date anywhere in the
    // next 1200 bytes may well belong to the NEXT card, and a card that borrows
    // its neighbour's date is indexed under a date that is confidently wrong -
    // which then fails the window gate for the wrong reason, or worse, passes it.
    // The fallback length bound is only for the last card on the page.
    const cardStart = match.index;
    const nextCard = source.indexOf('<div class="video_container', cardStart + 1);
    const sliceEnd =
      nextCard === -1 ? Math.min(source.length, cardStart + CARD_SLICE_CHARS) : nextCard;
    const slice = source.slice(cardStart, sliceEnd);
    const durationSec = parseClockDuration(
      slice.match(/title=["']Duration["'][^>]*>([^<]+)/i)?.[1] ?? null,
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

/** How far past an anchor to read when a page has no further card marker. */
const CARD_SLICE_CHARS = 1200;

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
  /**
   * Progress of the account loop, for the dashboard's live meter. Called once
   * per FINISHED account with its 1-based position, whether it indexed or
   * failed - a failed account is an attempt that completed, and the caption has
   * to be able to say so.
   */
  onUploader?: (done: number, total: number, uploader: string) => void;
}

export interface UploaderIndexReport {
  uploader: string;
  pagesFetched: number;
  indexed: number;
  undated: number;
  watermark: string | null;
  fullRewalk: boolean;
  pruned: number;
  /** True when the walk stopped on a 404 or a short page: it saw the whole list. */
  endOfListing: boolean;
  /**
   * True when a full re-walk completed but was truncated, so the prune-by-absence
   * was withheld. Surfaced rather than only logged: a run that silently stops
   * correcting deletions otherwise looks identical to a healthy one.
   */
  pruneSkipped?: boolean;
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
      const fullRewalk =
        fullRewalkDue(lastFullWalk, now, fullRewalkDays) || !Number.isFinite(watermarkMs);
      report.fullRewalk = fullRewalk;

      const seen = new Set<string>();
      // True only when the walk reached the genuine END of the listing. Every
      // heuristic stop below - nothing new, past the window, past the watermark,
      // a short page - leaves it false, and that distinction decides whether the
      // prune-by-absence below is allowed to delete anything.
      let reachedEnd = false;
      // The listing's own page size, measured rather than assumed. eporner
      // serves a fixed number of cards per page and the LAST page is short, so
      // "shorter than a full page" is the end-of-listing signal - but only
      // relative to a page size this walk actually observed. Hard-coding `12`
      // made the short-page test unreachable: the break fired before the 404
      // that would have set the flag, so for any account whose video count is
      // not an exact multiple of the page size the prune NEVER ran and upstream
      // deletions were never corrected.
      let pageSize = 0;
      for (let page = 1; page <= maxPages; page += 1) {
        const url = profileListingUrl(uploader, page);
        let entries: ProfileEntry[];
        try {
          const html = await cache(url, () =>
            fetcher.text(url, { headers: { accept: "text/html" } }),
          );
          report.pagesFetched += 1;
          entries = parseProfileListing(html, now);
        } catch (error) {
          // Walking off the end of the listing is a 404, and that is the normal
          // way a newest-first walk terminates - it is NOT an account failure.
          // Anything else (timeout, 403, 5xx, a shape change) is a real failure
          // and must surface as one, or a broken account would look healthy.
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
        // The first page is the reference: it is the one page guaranteed not to
        // be the short final page. A shrunken page size here simply means the
        // measured size is smaller, which is still correct - the test below is
        // relative, so eporner changing its page size needs no code change.
        if (page === 1) pageSize = entries.length;

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
            // The listing carries no view count. `null` here is a real "the
            // source did not say", and `upsertPoolVideo` COALESCEs it, so the
            // walk cannot blank a count an earlier hydration paid for.
            views: null,
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
        // A page shorter than the measured page size IS the final page. This is
        // the only page-level stop that genuinely reaches the end, so it is the
        // one that sets the flag and lets the prune run. It is checked LAST,
        // after the two confidence-ordered stops, so a page that is both short
        // and entirely stale still reports "truncated" - which is the safe
        // answer, because the prune is skipped rather than over-applied.
        if (pageSize > 0 && entries.length < pageSize) {
          reachedEnd = true;
          break;
        }
      }

      // Derived, never assigned at the break sites: those are three different
      // paths to the same conclusion, and setting the flag in only one of them
      // made a complete short-page walk report `endOfListing: false` - which the
      // cadence stamp below reads, so the re-walk could complete and still never
      // be recorded as complete.
      report.endOfListing = reachedEnd;

      if (fullRewalk) {
        // The re-walk is what corrects deletions and drift. Because the listing
        // carries no dates, correctness comes from ABSENCE: a row the walk did
        // not see has been deleted upstream. The date-keyed prune is kept for
        // any row that did acquire a date, so both paths stay honest.
        //
        // ONLY ON A COMPLETE WALK. Prune-by-absence reads "not seen" as "deleted",
        // and on a truncated walk "not seen" means "we stopped looking" - the
        // window stop, the watermark stop, the nothing-new stop, a short page,
        // or the maxPages ceiling. Deleting on that basis removes the entire
        // un-walked tail of the account in one pass, and because the rows are
        // gone the next walk has nothing left to stop on. `reachedEnd` is the
        // only thing that makes absence mean absence.
        if (reachedEnd) {
          report.pruned =
            store.prunePoolMissing(uploader, seen) +
            store.prunePoolUploader(uploader, new Date(windowStartMs).toISOString());
        } else {
          report.pruneSkipped = true;
          log("eporner pool: re-walk truncated, skipping the absence prune", {
            uploader,
            pagesFetched: report.pagesFetched,
            seen: seen.size,
          });
        }
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
    deps.onUploader?.(reports.length, uploaders.length, uploader);
  }

  // The cadence is stamped only when EVERY account that attempted a full re-walk
  // also reached the end of its listing. "No account errored" is not the same
  // thing: a walk truncated by the window, the watermark or the `maxPages`
  // ceiling completes cleanly and would defer the prune for a whole
  // `fullRewalkDays` - so a listing that stays just past the stop conditions
  // silently stops correcting upstream deletions forever. Accounts that did not
  // attempt a re-walk (`fullRewalk: false`) say nothing about completeness, so
  // they are not counted either way.
  //
  // THE KNOWN COST, STATED PLAINLY: this key is GLOBAL, not per-account. One
  // account that can never reach its end - permanently past the window, or past
  // `maxPages` - suppresses the stamp for all of them, so every account then
  // full-re-walks on EVERY cycle instead of every `fullRewalkDays`. That is
  // extra listing traffic against eporner, which is the cost of not silently
  // disabling the prune. The conservative direction is deliberate and is the
  // whole point of the change; making the cadence per-account would trade the
  // deletion-correction guarantee for request volume, and is a separate decision.
  const rewalked = reports.filter((report) => report.fullRewalk);
  if (rewalked.length && rewalked.every((report) => !report.error && report.endOfListing)) {
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
export type PoolRejection = "duration" | "date" | "none" | "incomplete";

export interface PoolMatch {
  url: string;
  embedUrl: string;
  videoId: string;
  uploader: string;
  title: string;
  /** The winner's identity tier. 0 means the title named neither performer nor scene. */
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
  /** Number of duration survivors left for a later bounded search. */
  omittedCandidates: number;
  /** Date-and-duration survivors retained for the terminal low-confidence fallback. */
  fallbackCandidates: TubeCandidate[];
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
 * Identity is deliberately NOT pre-filtered here. The actual identity gate runs
 * after hydration, date narrowing and title-stem collapse; applying it earlier
 * would judge a repost group member-by-member rather than on the group's best
 * title. Keeping all date+duration survivors also supplies the terminal
 * low-confidence fallback if no tube returns a named match. Search is bounded;
 * candidates are ordered by least recent hydration attempt so repeated runs
 * resume fairly instead of starving later rows behind insertion order.
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
  // The short-circuit needs both gate fields AND the view count on hand. A row
  // with a duration but no date is exactly the common case - the listing
  // supplies one and never the other - and returning it here would leave it
  // permanently undatable. Rows written before migration 0003 have date and
  // duration but no views; they must also pass through hydration once, or the
  // new view-count tiebreak would remain null forever on every existing row.
  // The API supplies views on the measured rows, so after this one backfill the
  // short-circuit is free again. If a source row has no count, it is not marked
  // separately; that uncommon case may be re-requested when another scene
  // considers it, rather than persisting a fabricated zero.
  if (video.durationSec !== null && video.added !== null && video.views !== null) {
    return {
      id: video.id,
      title: video.title ?? "",
      url: epornerWatchUrl(video.id),
      embed: epornerEmbedUrl(video.id),
      length_sec: video.durationSec,
      added: video.added,
      // Carried through, and this is the whole point of the short-circuit
      // carrying it. `rank` orders survivors by tier, then VIEWS, then lag, so a
      // row that reaches the matcher without a count skips the documented
      // tiebreak entirely and falls through to upload proximity - which is not
      // a quality signal. Before migration 0003 this field simply did not exist
      // and every fully-indexed row took that path.
      views: video.views,
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
    // The view count, normalised the same way the matcher normalises it, and
    // carried to BOTH the write and the returned candidate. Persisting it is
    // what makes the documented view-count tiebreak reachable on the pool rung
    // at all: the rung re-reads this row for the next scene, and a count that
    // was not written down has to be paid for again.
    const views = comparableViews(record.views);
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
    // A missing post must not hide the other candidates.
    return null;
  }
}

/**
 * A view count as a number, or null when the source said nothing usable.
 *
 * Duplicated from `matching.ts`'s private `viewCount` rather than imported: that
 * one is not exported, and exporting it would widen the module's surface for one
 * caller. The two must agree on what "no count" means - `null`, never `NaN` and
 * never 0 - because the value written to the index is the value the matcher
 * later reads, and a disagreement would show up only as a mis-ordered tiebreak.
 */
function comparableViews(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const suffix = /(k|m)$/i.exec(trimmed);
  const digits = trimmed.replace(/[,\s]/g, "").replace(/(?:views?|k|m)$/i, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  if (suffix) return value * (/^m$/i.test(suffix[1] as string) ? 1_000_000 : 1_000);
  return value;
}

/** What the duration pre-filter and hydration produced, before the date half. */
export interface PoolSurvivors {
  /** Index rows the duration pre-filter examined. */
  considered: number;
  /** Rows that survived the duration band. */
  durationPassed: number;
  /**
   * Every row that cleared the pre-filter, with the duration it was screened on.
   *
   * Reported BEFORE hydration, and deliberately not post-hydration: a hydration
   * failure removes a candidate from contention for reasons that have nothing to
   * do with duration, so counting it here would make the band look emptier than
   * it is. The purpose is band occupancy at a tolerance NARROWER than the one
   * the gather ran with, which is a question about the index and can be answered
   * from these numbers without a second scan. Rows with no title are absent,
   * because a title-less row hashes to an empty title stem and is never a
   * candidate however well its duration agrees.
   */
  survivorDurations: number[];
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
 * In-flight `video/id` hydrations per scene. Fixed rather than configurable:
 * the hydration is NESTED inside `resolveLinks`' own fan-out, so the real
 * ceiling is this times the outer limit, and a knob here would let a caller
 * silently reintroduce the burst the bound exists to prevent. 4 keeps the worst
 * case at 16 requests in flight at the default `fetchConcurrency` of 4.
 */
const POOL_HYDRATION_CONCURRENCY = 4;

// Keep scan and hydration progress ordered across runs and seed from saved
// progress after a restart, even when the clock is behind earlier scans.
const poolProgressTimes = new WeakMap<SqliteStore, number>();

function nextPoolProgressAt(now: Date, store: SqliteStore): string {
  let previous = poolProgressTimes.get(store);
  if (previous === undefined) {
    const persisted = store.latestPoolProgressAt();
    previous = persisted === null ? -Infinity : Date.parse(persisted);
  }
  const next = Math.max(now.getTime(), previous + 1);
  poolProgressTimes.set(store, next);
  return new Date(next).toISOString();
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
  // The duration half of the gate, as SQL arithmetic, so a dated row the gate
  // would reject anyway never reaches the scan. A row with no duration is kept:
  // the gate examines those rather than assuming a length it does not have.
  // Without this the scan budget is spent on rows that cost nothing to reject
  // and never rotate - they are the same rows every run - and once an account
  // holds more dated rows in the window than `maxConsidered`, its UNDATED
  // working set is never examined again. That working set is where the rows
  // still missing an upload date live, so the starvation was permanent: a valid
  // candidate could never be hydrated, however many runs went by.
  const band =
    typeof scene.durationSec === "number" && Number.isFinite(scene.durationSec)
      ? { durationSec: scene.durationSec, toleranceSec: durationToleranceSec }
      : undefined;
  for (const uploader of uploaders) {
    // Dated rows are narrowed to the window - and to the duration band - by
    // SQL. The listing normally supplies no date, so the undated rows are the
    // working set: they cannot be date-narrowed, so they are pre-filtered on
    // duration alone. Same gate, more rows examined, no less safety.
    const dated = band
      ? store.poolVideosInWindow(uploader, from, to, band)
      : store.poolVideosInWindow(uploader, from, to);
    // The cap is pushed into SQL. Undated rows are the working set and the
    // account can hold thousands of them; materialising all of them and
    // discarding most in JavaScript made the per-scene cost scale with the
    // account's whole history rather than with the budget.
    const undated = store.poolVideosUndated(uploader, maxConsidered);
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
        store.markPoolUndatedScan(row.id, row.uploader, nextPoolProgressAt(now, store));
      }
    }
  }
  const survivorDurations = survivors.flatMap((row) =>
    row.durationSec === null ? [] : [row.durationSec],
  );
  if (!survivors.length)
    return { considered, durationPassed: 0, survivorDurations, candidates: [], capped: false };

  // Hydration is the only network cost in this rung, and it is bounded.
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
  // Hydration is the only network cost in this rung, and it is bounded TWICE:
  // by how many rows are queued (`maxHydrations`) and by how many are in flight
  // at once. `Promise.all` over the whole queue honoured the first and ignored
  // the second - a 40-way burst of `video/id` requests from a single scene.
  //
  // The in-flight bound is `mapIsolated`, NOT the shared pool. This runs inside
  // `resolveLinks`' own fan-out, so a caller already holds its slot, and asking
  // the shared (non-re-entrant) pool for a second one deadlocks the moment both
  // fan-outs reach their limit. The number is deliberately fixed and small:
  // 4 outer scenes x 4 hydrations = 16 in flight, against the 40-way
  // `Promise.all` this replaced and against this being the request path most
  // likely to draw a 429 from eporner.
  const hydrated = await mapIsolated(
    queue,
    async (video) => {
      store.markPoolHydrationAttempt(video.id, video.uploader, nextPoolProgressAt(now, store));
      return hydrate(video, { store, fetcher, now });
    },
    POOL_HYDRATION_CONCURRENCY,
  );
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
  return { considered, durationPassed: survivors.length, survivorDurations, candidates, capped };
}

/**
 * Build the pool rung. Every scene with a positive duration is eligible; a
 * performer-less scene can still contribute date+duration survivors to the
 * terminal fallback, but cannot receive a high-confidence pool match without
 * identity evidence.
 */
export function createPoolLookup(options: PoolLookupOptions) {
  const { store, fetcher, uploaders, durationToleranceSec, dateWindowDays, log } = options;

  return async (scene: MatchScene, now: Date): Promise<PoolMatch | null> => {
    if (!Number.isFinite(scene.durationSec) || (scene.durationSec ?? 0) <= 0) return null;
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

    // The date half, counted as it rejects. A rung that cannot supply dates at
    // all is the failure mode this is here to make visible: the funnel shows an
    // unknown-date count and no links, rather than a silent fall-through to the
    // more expensive rung below that reads as "this scene has no video".
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

    // `requireIdentity` is the gate, and it is the whole point of this change.
    // Measured on 2026-09-30 over the 46 links this rung produced: 36 winners
    // carried no identity evidence and every one of them was the wrong video -
    // a 1847s scene for Vivian Fernandes linked to a 1845s video titled "Aceita
    // Dupla Penetracao". Gating here means a no-match the LADDER can act on, so
    // the scene moves to sxyprn instead of being written as a confident wrong
    // URL. See `PickOptions.requireIdentity`.
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
    // If no candidates passed the date half, preserve that rejection in the
    // rung result. Otherwise a null pick means that no candidate could be
    // ranked - under `requireIdentity`, usually because every stem group was
    // unnamed. Do not misreport THAT as a date rejection: the counters already
    // know exactly how many date checks failed.
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
  omittedCandidates: 0,
  fallbackCandidates: [],
  rejected: "none",
};
