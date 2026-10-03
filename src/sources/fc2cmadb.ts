/**
 * fc2cmadb.com - the FC2 lane, and the only lane that may link more than one
 * upload to a single scene.
 *
 * WHAT THE SITE ACTUALLY IS, measured rather than assumed (the previous version
 * of this file shipped as a stub precisely because nobody had looked):
 *
 *   listing  `GET /tags/<name>` is a Laravel Inertia page. The payload lives in
 *            `<script data-page="app" type="application/json">` and the article
 *            list is a CURSOR paginator: `props.articles.next_cursor`, with
 *            `next_page_url` carrying the same cursor as a `?cursor=` parameter.
 *            `?per_page=` is ignored - the server clamps to 30 - and `?page=` is
 *            ignored too, because this paginator is not offset-based. Walking by
 *            `page=2` returns page 1 forever, which is the kind of silent
 *            truncation that would make the lane look healthy and empty.
 *            Records arrive newest-first by descending `video_id`.
 *   detail   `GET /articles/<video_id>` is an Inertia page whose
 *            `props.article` carries the FULL tag list. The listing does not:
 *            the safety and trans exclusions read tags, so a decision cannot be
 *            made from the listing alone.
 *
 * The anal tag is `アナル`, and its pivot confirms it: every record walked from
 * that tag carries `pivot.tag_id === 47`, which is the id the plan names. The
 * pivot is CHECKED per record rather than trusted once, so a listing that
 * started mixing in another tag would drop the foreign rows instead of
 * ingesting them.
 *
 * THE CENSORSHIP RULE IS DELIBERATELY STRICT, and it is the reason this lane has
 * three outcomes rather than two. The site reports `censored` as `無` (uncensored),
 * `有` (censored), or `null` - and `null` is the COMMON case, not an edge case:
 * 27 of the 30 newest anal-tag records carried no badge at all. So:
 *
 *   `無`  -> accepted, subject to the documented exclusions.
 *   `有`  -> excluded. The site said censored.
 *   null  -> PENDING. Neither accepted nor classified as censored. The candidate
 *            is retried until its bounded recheck period expires and is then
 *            retired undecided, which keeps an unmarked record from costing a
 *            slow detail request forever while never asserting a fact the site
 *            did not state.
 *
 * WHY EVERY FAILURE FAILS THE RUN. A 429, a missing or reshaped Inertia payload,
 * a record with no id, or a walk that stops without its final cursor all throw.
 * Throwing is what preserves the lane's last-good scenes; returning a partial
 * walk would let `verifiedEmpty` claim a verified emptiness that was never
 * verified, and the retention rule would then delete real records.
 *
 * WHY THE DETAIL WALK IS BOUNDED AND RESUMABLE. A detail page costs 8-9 seconds
 * of politeness spacing, and a 90-day window holds hundreds of candidates, so a
 * sync cannot check them all. It checks a bounded number, oldest-first, and the
 * decisions live in `fc2_candidates`; the next sync continues where this one
 * stopped. That is also why a fresh instance is safe: the table is gone with the
 * instance, the walk starts over, and an absent row only means a detail request
 * is paid a second time.
 */
import type { Fc2Status } from "../core/schema.ts";
import type { Fc2Candidate, SqliteStore } from "../core/store/sqlite.ts";
import { parseClockDuration } from "../tubes/eporner-pool.ts";
import type { Fetcher, RawScene, SourceAdapter, SourceContext, SourceResult } from "./types.ts";

export const FC2CMADB_ID = "fc2cmadb";
export const FC2CMADB_LANE = "FC2";
export const FC2CMADB_BASE = "https://fc2cmadb.com";

/** The Japanese anal tag. Every record on this listing pivots on tag id 47. */
export const FC2_ANAL_TAG_NAME = "アナル";
export const FC2_ANAL_TAG_ID = 47;

export const FC2_LISTING_URL = `${FC2CMADB_BASE}/tags/${encodeURIComponent(FC2_ANAL_TAG_NAME)}`;
/** Build the public detail URL for a numeric release ID. */
export const fc2RecordUrl = (videoId: string): string => `${FC2CMADB_BASE}/articles/${videoId}`;

/** The site clamps the page size to 30 and ignores `per_page`. */
export const FC2_LISTING_PAGE_SIZE = 30;

/** Spacing and bounds. Defaults are the site's own stated limits. */
export const DEFAULT_FC2_LISTING_INTERVAL_MS = 2000;
export const DEFAULT_FC2_DETAIL_INTERVAL_MS = 8500;
export const DEFAULT_FC2_MAX_DETAIL_CHECKS = 20;
export const DEFAULT_FC2_RECHECK_DAYS = 7;
/**
 * A hard ceiling on listing pages per sync.
 *
 * The window bound is what normally ends a walk (roughly a dozen pages for 90
 * days at 30 per page). This is the backstop for the case the window bound
 * cannot cover - a listing whose release dates are all inside the window would
 * otherwise walk until the site ran out of records, at 2 seconds a page.
 * Reaching it is an INCOMPLETE walk and fails the run rather than reporting a
 * truncated catalogue as complete.
 */
export const DEFAULT_FC2_MAX_LISTING_PAGES = 40;

/** A named failure, so the health card can say what actually went wrong. */
export class Fc2SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Fc2SourceError";
  }
}

/** Throttling. Its own name because it is the one failure that resolves. */
export class Fc2RateLimitedError extends Fc2SourceError {
  constructor() {
    super(
      "fc2cmadb.com rate-limited the FC2 lane (HTTP 429). The site asks for slow, paced reads, so the run failed rather than returning a partial walk; the lane's last-good scenes are retained.",
    );
    this.name = "Fc2RateLimitedError";
  }
}

/** The page shape changed, or was never an Inertia page. */
export class Fc2ShapeError extends Fc2SourceError {
  constructor(detail: string) {
    super(
      `fc2cmadb.com returned an unrecognised page (${detail}). The lane cannot trust this response, so the run failed and its last-good scenes are retained.`,
    );
    this.name = "Fc2ShapeError";
  }
}

// -------------------------------------------------------------- Inertia page

export interface InertiaPage {
  component: string;
  props: Record<string, unknown>;
  url: string | null;
  version: string | null;
}

/**
 * Pull the Inertia payload out of a page body.
 *
 * The payload is a JSON document inside a `<script type="application/json">`, so
 * it carries no HTML-escaping of its own; unescaping anyway is harmless and
 * covers a body that has been through an editor. A missing or unparseable
 * payload throws `Fc2ShapeError` rather than returning an empty page, because an
 * empty page is indistinguishable from a tag with no articles.
 */
export function extractInertiaPage(html: string): InertiaPage {
  const body = String(html);
  const match = body.match(
    /<script[^>]*\bdata-page=["'][^"']*["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) throw new Fc2ShapeError("no Inertia page payload");
  const raw = (match[1] as string)
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Fc2ShapeError(`page payload is not valid JSON (${(error as Error).message})`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Fc2ShapeError("page payload is not an object");
  }
  const record = parsed as Record<string, unknown>;
  const props = record.props;
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new Fc2ShapeError("page payload has no props object");
  }
  return {
    component: typeof record.component === "string" ? record.component : "",
    props: props as Record<string, unknown>,
    url: typeof record.url === "string" ? record.url : null,
    version: typeof record.version === "string" ? record.version : null,
  };
}

// ------------------------------------------------------------------- listing

export interface Fc2ListingRecord {
  videoId: string;
  title: string;
  /** `YYYY-MM-DD` or "" when the listing carried none. */
  releaseDate: string;
  duration: string | null;
  censored: string | null;
  notFound: boolean;
  tagId: number | null;
  thumbnailUrl: string;
}

export interface Fc2Listing {
  records: Fc2ListingRecord[];
  /** The next cursor, or null at the final page. */
  nextCursor: string | null;
}

/** Preserve the site's UTC date prefix without inventing a missing date. */
function dateOnlyOf(value: unknown): string {
  return typeof value === "string" ? (value.match(/^\d{4}-\d{2}-\d{2}/)?.[0] ?? "") : "";
}

/** Recognize only explicit upstream removal flags. */
function truthyFlag(value: unknown): boolean {
  // The site sends `null` for "nothing to report" and occasionally `1`, `"1"`
  // or `true`. Anything else - including the string "0" - is treated as the
  // flag being absent, because this field only ever marks a REMOVED record and
  // over-reading it would delete a live scene from the catalogue.
  return value === 1 || value === true || value === "1";
}

/** Read a required listing identity and retain its tag pivot for admission. */
function parseListingRecord(value: unknown): Fc2ListingRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawId = record.video_id;
  const videoId = rawId === undefined || rawId === null ? "" : String(rawId).trim();
  if (!/^\d+$/.test(videoId)) return null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (!title) return null;
  const pivot = record.pivot;
  const tagId =
    pivot && typeof pivot === "object"
      ? Number((pivot as Record<string, unknown>).tag_id ?? Number.NaN)
      : Number.NaN;
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

/**
 * Read one anal-tag listing page.
 *
 * The component and the tag name are both asserted. The site serves the same
 * Inertia component for every tag, so a walk that lost its cursor and restarted
 * would otherwise be indistinguishable from a healthy walk - it would just
 * return some other tag's releases. Checking `props.tag_name` is what makes a
 * lost cursor a loud failure instead of a wrong catalogue.
 */
export function parseFc2Listing(page: InertiaPage): Fc2Listing {
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
  const paginator = articles as Record<string, unknown>;
  if (!Array.isArray(paginator.data)) {
    throw new Fc2ShapeError("the tag listing has no article array");
  }
  const cursor = paginator.next_cursor;
  if (cursor !== null && typeof cursor !== "string") {
    throw new Fc2ShapeError("the tag listing has no usable next cursor");
  }
  const records: Fc2ListingRecord[] = [];
  for (const entry of paginator.data) {
    const record = parseListingRecord(entry);
    if (!record) throw new Fc2ShapeError("the listing contains a malformed article");
    records.push(record);
  }
  return { records, nextCursor: cursor === null ? null : (cursor as string) };
}

// -------------------------------------------------------------------- detail

export interface Fc2Detail {
  videoId: string;
  title: string;
  releaseDate: string;
  duration: string | null;
  durationSec: number | null;
  censored: string | null;
  notFound: boolean;
  tags: string[];
  thumbnailUrl: string;
  seller: string | null;
}

/**
 * Read one article detail page.
 *
 * Unlike the listing, a detail record MISSING its id or title is a shape change
 * and throws: the record is the unit of classification, and a half-read one
 * would either be dropped silently (hiding a qualifying release) or admitted
 * with a missing badge (importing an unverified one).
 */
export function parseFc2Detail(page: InertiaPage): Fc2Detail {
  if (page.component !== "Articles/Show") {
    throw new Fc2ShapeError(`expected the Articles/Show component, saw "${page.component}"`);
  }
  const article = page.props.article;
  if (!article || typeof article !== "object" || Array.isArray(article)) {
    throw new Fc2ShapeError("the article page carries no article");
  }
  const record = article as Record<string, unknown>;
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
              .map((tag) =>
                tag && typeof tag === "object"
                  ? String((tag as Record<string, unknown>).name ?? "").trim()
                  : "",
              )
              .filter(Boolean),
          ),
        ]
      : [],
    thumbnailUrl: typeof record.image_url === "string" ? record.image_url : "",
    seller:
      writer && typeof writer === "object"
        ? String((writer as Record<string, unknown>).name ?? "").trim() || null
        : null,
  };
}

// --------------------------------------------------------------- classifier

/**
 * The two documented exclusion families, and ONLY these two.
 *
 * Both are matched against the site's own tag names and the original Japanese
 * title, and both are narrow on purpose: a filter that starts catching adult
 * releases by accident removes them silently, which is worse than leaving them
 * in. `TS` and the school-year shorthand are matched as whole tokens because
 * `TS` in particular appears inside unrelated latin text.
 */
export const FC2_SAFETY_TERMS: readonly string[] = Object.freeze([
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

export const FC2_TRANS_TERMS: readonly string[] = Object.freeze([
  "トランスジェンダー",
  "性転換",
  "女装",
  "女装家",
  "偽娘",
  "男の娘",
  "女体化",
  "MtF",
  "FtM",
  "drag queen",
  "crossdress",
  "transgender",
]);

/** Whole-token alternatives, matched case-insensitively outside Japanese text. */
const FC2_SAFETY_WORD_TERMS: readonly string[] = Object.freeze([
  "child",
  "children",
  "teen",
  "teens",
  "schoolgirl",
  "schoolboy",
  "femboy",
]);

const FC2_TRANS_WORD_TERMS: readonly string[] = Object.freeze(["ts", "trans"]);

/** A Latin substring match, so Japanese text cannot accidentally satisfy it. */
function matchesLatinTerm(haystack: string, term: string): boolean {
  return new RegExp(
    `(^|[^0-9a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9a-z]|$)`,
    "i",
  ).test(haystack);
}

/** Return the first documented substring exclusion present in title or tags. */
function firstMatch(haystack: string, terms: readonly string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const term of terms) if (lower.includes(term.toLowerCase())) return term;
  return null;
}

/** Match Latin exclusion words without catching unrelated longer words. */
function firstWordMatch(haystack: string, terms: readonly string[]): string | null {
  for (const term of terms) if (matchesLatinTerm(haystack, term)) return term;
  return null;
}

export interface Fc2Verdict {
  status: Fc2Status;
  /** The classifier's own reason, persisted so a card can explain itself. */
  verdict: string;
}

export interface Fc2ClassifyInput {
  censored: string | null;
  durationSec: number | null;
  notFound: boolean;
  releaseDate: string;
  title: string;
  tags: readonly string[];
}

/**
 * Decide one candidate. Pure, and order-dependent - see the file note.
 *
 * The exclusions run BEFORE the badge is read, so a record the site badges
 * `censored` is still excluded for a safety term: the two are independent facts
 * and reporting only the first would understate what was rejected.
 */
export function classifyFc2Candidate(input: Fc2ClassifyInput): Fc2Verdict {
  const haystack = [input.title, ...input.tags].join("\n");
  if (input.notFound) return { status: "excluded", verdict: "record removed from the site" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.releaseDate)) {
    return { status: "excluded", verdict: "no release date" };
  }
  const safety =
    firstMatch(haystack, FC2_SAFETY_TERMS) ?? firstWordMatch(haystack, FC2_SAFETY_WORD_TERMS);
  if (safety) return { status: "excluded", verdict: `safety exclusion: ${safety}` };
  const trans =
    firstMatch(haystack, FC2_TRANS_TERMS) ?? firstWordMatch(haystack, FC2_TRANS_WORD_TERMS);
  if (trans) return { status: "excluded", verdict: `trans/crossdress exclusion: ${trans}` };
  // A record with no playable length cannot be compared to an upload's length, so
  // it can never be resolved - and it is not a release that is merely unread
  // either. fc2cmadb carries IMAGE SETS alongside videos (their length reads as a
  // count such as "60 images"), so this is a real shape of record, not a gap in the
  // page. Leaving it `pending` would re-check it for ever and stop the walk ever
  // being able to claim it saw everything, which is the opposite of what pending is
  // for. Unreadable PAGES stay pending; a page that was read and says this stays
  // excluded.
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

// ------------------------------------------------------------- scene mapping

/**
 * Map a classified detail record to the canonical raw scene.
 *
 * No new fields: the Japanese title is kept verbatim (there is no translation in
 * this lane and none is planned), the identity is the FC2 release id, and the
 * classifier's own verdict rides along as provenance so a card can say why it is
 * in the catalogue without a second lookup.
 */
export function toFc2RawScene(detail: Fc2Detail, verdict: Fc2Verdict): RawScene {
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

// ------------------------------------------------------------------- client

export interface Fc2ClientOptions {
  listingMinIntervalMs?: number;
  detailMinIntervalMs?: number;
  /** Injected so tests exercise the walk without waiting out the pacing. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export interface Fc2Client {
  /** One cursor page of the anal tag listing. */
  listAnalTag(cursor: string | null): Promise<Fc2Listing>;
  /** One article detail page. */
  getArticle(videoId: string): Promise<Fc2Detail>;
}

function pacing(
  lastRequest: { at: number },
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
) {
  return async (): Promise<void> => {
    const wait = intervalMs - (Date.now() - lastRequest.at);
    if (wait > 0) await sleep(wait);
    lastRequest.at = Date.now();
  };
}

/**
 * A paced fc2cmadb client.
 *
 * The two spacings are kept in SEPARATE gates on purpose. A detail page costs
 * far more of the site's patience than a listing page, so pacing them together
 * would either slow the cheap walk to the detail delay or let the detail walk
 * hammer at listing speed. They also run on independent clocks because a detail
 * page in the middle of a listing walk must not reset the listing clock - the
 * walk would otherwise drift by a full 8.5 seconds per detail read.
 */
export function createFc2Client(
  ctx: { fetcher: Fetcher },
  {
    listingMinIntervalMs = DEFAULT_FC2_LISTING_INTERVAL_MS,
    detailMinIntervalMs = DEFAULT_FC2_DETAIL_INTERVAL_MS,
    sleep = defaultSleep,
  }: Fc2ClientOptions = {},
): Fc2Client {
  const listingGate = { at: 0 };
  const detailGate = { at: 0 };
  const waitListing = pacing(listingGate, listingMinIntervalMs, sleep);
  const waitDetail = pacing(detailGate, detailMinIntervalMs, sleep);

  async function html(url: string, wait: () => Promise<void>): Promise<string> {
    await wait();
    const response = await ctx.fetcher.fetch(url, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (response.status === 429) throw new Fc2RateLimitedError();
    if (response.status === 404 || response.status === 410) {
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
        extractInertiaPage(await html(fc2RecordUrl(videoId), waitDetail)),
      );
      if (detail.videoId !== videoId)
        throw new Fc2ShapeError(`expected article ${videoId}, saw ${detail.videoId}`);
      return detail;
    },
  };
}

// ------------------------------------------------------------------ adapter

export interface Fc2StudioOptions extends Fc2ClientOptions {
  /** Optional. Without it the lane runs but never remembers its decisions. */
  store?: SqliteStore | null;
  maxDetailChecksPerSync?: number;
  recheckDays?: number;
  maxListingPages?: number;
}

/** The paging state that must persist across syncs for a walk to resume. */
interface WalkState {
  cursor: string | null;
  pages: number;
  /** Ids seen on this walk, so a repeated cursor cannot loop forever. */
  seen: Set<string>;
}

/**
 * Walk the anal-tag listing, newest first, and stop at the window edge.
 *
 * STOPPING IS A COMPLETION, and this is the one place the lane makes an
 * assumption worth stating. The listing is ordered by descending release id,
 * which tracks release order closely but not perfectly: a seller can date a
 * release backwards, so a record with an old id can carry a recent date. The
 * walk therefore stops on a page that yields NO record inside the active window
 * rather than on the first out-of-window record, which keeps one backdated page
 * from ending the walk early. Reaching that point means every page above it was
 * examined, which is what `verifiedEmpty` is allowed to assume.
 *
 * A repeated cursor is an incomplete walk and throws. Without that check a
 * cursor the site does not honour would return the same page forever and the
 * lane would finish its page budget having seen one page of thirty.
 */
export async function walkFc2Listing(
  client: Fc2Client,
  windowStart: string,
  {
    maxPages = DEFAULT_FC2_MAX_LISTING_PAGES,
    log,
  }: { maxPages?: number; log?: (m: string, f?: Record<string, unknown>) => void } = {},
): Promise<{ records: Fc2ListingRecord[]; pages: number; reachedEnd: boolean }> {
  const state: WalkState = { cursor: null, pages: 0, seen: new Set() };
  const records: Fc2ListingRecord[] = [];
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
      return { records, pages: page, reachedEnd: true };
    }
    if (listing.nextCursor === null) return { records, pages: page, reachedEnd: true };

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

/** Admit dated records inside the inclusive operating window through now. */
function withinWindow(releaseDate: string, windowStart: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
  const at = Date.parse(`${releaseDate}T00:00:00Z`);
  return Number.isFinite(at) && at >= Date.parse(`${windowStart}T00:00:00Z`) && at <= now.getTime();
}

/**
 * The FC2 lane.
 *
 * The rolling window is the app-wide one applied by `sync`; the lane keeps no
 * retention of its own, so the multi-thousand-record historical archive is never
 * held. Those records are classification material, not runtime data.
 *
 * WITHOUT A STORE THE LANE STILL RUNS, and it runs correctly but forgetfully:
 * every accepted record is re-derived from its detail page on every sync, which
 * is slow and rate-limit-prone. The store is what makes the lane affordable, so
 * it is optional only because the adapter is also used in tests that do not want
 * a database.
 */
export function createFc2CmadbStudio(options: Fc2StudioOptions = {}): SourceAdapter {
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
    // FC2 releases are excluded from no gate. They leave the ordinary matcher
    // path by LANE, not by declaration: `tubes/fc2-eporner.ts` resolves them with
    // an exact-release-code eporner lookup that no other lane shares.
    matcher: "sxyprn+eporner",
    async fetch(windowStart: string, ctx: SourceContext): Promise<SourceResult> {
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

      // Everything the walk saw is REMEMBERED, including records this sync will
      // not check. That is what stops the next sync from paying for the same
      // detail page again merely because it has not been read yet.
      if (store) {
        store.deleteFc2CandidatesBefore(windowStart);
        store.noteFc2Sightings(
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
        store?.decideFc2Candidate(
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
        ? store.fc2Candidates(walk.records.map((record) => record.videoId))
        : new Map<string, Fc2Candidate>();

      // The queue is oldest-first, so a bounded sync spends its checks on the
      // records that have waited longest rather than re-reading the newest page
      // forever.
      //
      // WITHOUT A STORE there is no memory, so the walk IS the queue: every
      // in-window record is undecided by definition and is checked newest-first,
      // which still terminates and simply gives no fairness guarantee. Deriving
      // the queue from the (empty) state map instead would check nothing at all
      // and report a lane that is configured, running, and finding no releases.
      const inWindowIds = walk.records
        .filter(
          (record) =>
            !listingExcluded.has(record.videoId) &&
            withinWindow(record.releaseDate, windowStart, now),
        )
        .map((record) => record.videoId);
      const due = store
        ? store.fc2DueCandidates(now, budget)
        : inWindowIds
            .filter((videoId) => states.get(videoId)?.status !== "accepted")
            .slice(0, budget)
            .map(
              (videoId): Fc2Candidate =>
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
      // Scenes decided THIS run. The `states` snapshot above predates the detail
      // walk, so an acceptance has to be remembered here as well - otherwise the
      // emit loop below would only find the cached copies of PREVIOUS runs and
      // this sync would emit nothing for a record it had just accepted.
      const excludedSceneIds = new Set(listingExcluded);
      for (const candidate of states.values())
        if (candidate.status === "excluded") excludedSceneIds.add(candidate.videoId);
      const fresh = new Map<string, RawScene>();
      let checked = 0;
      let classifiedPending = 0;
      for (const candidate of due) {
        let detail: Fc2Detail;
        try {
          detail = await client.getArticle(candidate.videoId);
        } catch (error) {
          // A failed detail read is NOT a classification. Retrying the record next
          // sync costs one paced request; guessing a verdict costs the lane its
          // honesty. It therefore stays pending, and stays due.
          ctx.log("fc2: detail check failed, leaving the candidate pending", {
            videoId: candidate.videoId,
            error: (error as Error).message,
          });
          throw error;
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
        store?.decideFc2Candidate(candidate.videoId, verdict.status, verdict.verdict, {
          checkedAt: now.toISOString(),
          // Only an UNDECIDED record is scheduled for another look. Accepted and
          // excluded are decisions, not retries.
          recheckAt: verdict.status === "pending" ? (candidate.recheckAt ?? recheckAt) : null,
          scene: (scene ?? null) as Record<string, unknown> | null,
        });
        // A scheduled retry must actually succeed before an unmarked record can
        // retire. Failed reads and candidates outside this sync's budget stay due.
        if (store && verdict.status === "pending" && candidate.recheckAt !== null) {
          retired += store.retireFc2StalePending(candidate.videoId, now);
        }
      }

      // An ACCEPTED record is re-emitted every sync from its cached scene, and
      // that is the whole reason the cache exists: the record is in the catalogue
      // for as long as it is in the window, so a source that stopped re-deriving
      // it would leave it un-refreshed while still counting as healthy.
      const scenes: RawScene[] = [];
      let undecided = 0;
      for (const record of walk.records) {
        if (
          listingExcluded.has(record.videoId) ||
          !withinWindow(record.releaseDate, windowStart, now)
        )
          continue;
        const accepted = fresh.get(record.videoId);
        if (accepted) {
          scenes.push(accepted);
          continue;
        }
        const cached = states.get(record.videoId);
        if (cached?.status === "accepted" && cached.scene) {
          scenes.push(cached.scene as unknown as RawScene);
          continue;
        }
        if (cached?.status === "pending") undecided += 1;
        // No state and no decision: the record was queued this sync and its
        // detail read either failed or is still owed. Either way it is not a
        // scene yet.
      }

      if (!store) undecided += classifiedPending + inWindowIds.length - due.length;
      const pending = store ? store.countFc2Pending() : undecided;
      const deferred = store ? pending : undecided;
      // `verifiedEmpty` needs all THREE of: a finished walk, no qualifying
      // record, and no outstanding undecided work. Claiming it while detail
      // checks are still owed would assert a completeness the lane does not have,
      // and the sync's retention rule would then act on the claim.
      const verifiedEmpty = scenes.length === 0 && deferred === 0;
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
