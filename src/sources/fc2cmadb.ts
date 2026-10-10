/**
 * fc2cmadb.com - the FC2 lane: simplified listing-only discovery.
 *
 * WHAT THE SITE ACTUALLY IS, measured rather than assumed:
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
 *
 * THE CENSORSHIP RULE IS SIMPLIFIED: the listing has `censored` as `無` (uncensored),
 * `有` (censored), or `null` (unknown). Only `"有"` is excluded explicitly.
 * Records with `null` are emitted - some censored ones will leak through, but
 * this avoids the detail-page budget entirely.
 *
 * TRANS/SAFETY EXCLUSIONS run against the listing TITLE only (no tags available
 * on listing). The shared `findTransExclusion` covers Japanese/English terms.
 *
 * MATCHING: by FC2 code only (sxyprn + eporner both index the code). No title
 * fuzzy matching, no duration verification.
 */
import { parseClockDuration } from "../tubes/eporner.ts";
import type { Fetcher, RawScene, SourceAdapter, SourceContext, SourceResult } from "./types.ts";
import { findSafetyExclusion, findTransExclusion } from "./trans-exclusion.ts";

export const FC2CMADB_ID = "fc2cmadb";
export const FC2CMADB_LANE = "FC2";
export const FC2CMADB_BASE = "https://fc2cmadb.com";

/** The Japanese anal tag, and the only tag this lane reads. */
export const FC2_ANAL_TAG_NAME = "アナル";

export const FC2_LISTING_URL = `${FC2CMADB_BASE}/tags/${encodeURIComponent(FC2_ANAL_TAG_NAME)}`;
/** Build the public detail URL for a numeric release ID. */
export const fc2RecordUrl = (videoId: string): string => `${FC2CMADB_BASE}/articles/${videoId}`;

/** A hard ceiling on listing pages per sync. */
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
 * it carries no HTML-escaping of its own, and it is read exactly as it arrived.
 * Unescaping `&quot;` and friends is a FALLBACK, not a preparation step.
 */
export function extractInertiaPage(html: string): InertiaPage {
  const body = String(html);
  const match = body.match(
    /<script[^>]*\bdata-page=["'][^"']*["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) throw new Fc2ShapeError("no Inertia page payload");
  const asSent = match[1] as string;
  const unescaped = asSent
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  let parsed: unknown;
  try {
    parsed = JSON.parse(asSent);
  } catch (error) {
    try {
      parsed = JSON.parse(unescaped);
    } catch {
      throw new Fc2ShapeError(`page payload is not valid JSON (${(error as Error).message})`);
    }
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
  /** The seller/uploader name from the listing. */
  sellerName: string | null;
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
  const writer = record.writer;
  const sellerName =
    writer &&
    typeof writer === "object" &&
    typeof (writer as Record<string, unknown>).name === "string"
      ? String((writer as Record<string, unknown>).name)
      : null;
  return {
    videoId,
    title,
    releaseDate: dateOnlyOf(record.release_date),
    duration: typeof record.duration === "string" ? record.duration : null,
    censored: typeof record.censored === "string" ? record.censored : null,
    notFound: truthyFlag(record.not_found),
    tagId: Number.isFinite(tagId) ? tagId : null,
    thumbnailUrl: typeof record.image_url === "string" ? record.image_url : "",
    sellerName,
  };
}

/**
 * Read one anal-tag listing page.
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

// ------------------------------------------------------------------- client

export interface Fc2ClientOptions {
  listingMinIntervalMs?: number;
  /** Injected so tests exercise the walk without waiting out the pacing. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The pacing wait - a plain timer that HOLDS the event loop open.
 */
const defaultSleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

export interface Fc2Client {
  /** One cursor page of the anal tag listing. */
  listAnalTag(cursor: string | null): Promise<Fc2Listing>;
}

/** Create a wait callback that spaces sequential requests using a shared timestamp. */
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
 * A paced fc2cmadb client (listing only, no detail fetches).
 */
export function createFc2Client(
  ctx: { fetcher: Fetcher },
  { listingMinIntervalMs = 2000, sleep = defaultSleep }: Fc2ClientOptions = {},
): Fc2Client {
  const listingGate = { at: 0 };
  const waitListing = pacing(listingGate, listingMinIntervalMs, sleep);

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
  };
}

// ------------------------------------------------------------------- walk

interface WalkState {
  cursor: string | null;
  pages: number;
  /** Ids seen on this walk, so a repeated cursor cannot loop forever. */
  seen: Set<string>;
}

/**
 * Walk the anal-tag listing, newest first, and stop at the window edge.
 *
 * STOPPING IS A COMPLETION. The listing is ordered by descending release id,
 * which tracks release order closely but not perfectly: a seller can date a
 * release backwards, so a record with an old id can carry a recent date. The
 * walk therefore stops on a page that yields NO record inside the active window
 * rather than on the first out-of-window record.
 *
 * `edgeStop` is true when the walk stopped at the window edge while the site
 * still offered a next cursor, meaning pages below it were never examined.
 */
export async function walkFc2Listing(
  client: Fc2Client,
  windowStart: string,
  {
    maxPages = DEFAULT_FC2_MAX_LISTING_PAGES,
    log,
  }: { maxPages?: number; log?: (m: string, f?: Record<string, unknown>) => void } = {},
): Promise<{
  records: Fc2ListingRecord[];
  pages: number;
  reachedEnd: boolean;
  edgeStop: boolean;
}> {
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

/** Admit dated records inside the inclusive operating window through now. */
function withinWindow(releaseDate: string, windowStart: string, now: Date): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) return false;
  const at = Date.parse(`${releaseDate}T00:00:00Z`);
  return Number.isFinite(at) && at >= Date.parse(`${windowStart}T00:00:00Z`) && at <= now.getTime();
}

// ------------------------------------------------------------------ adapter

export interface Fc2StudioOptions extends Fc2ClientOptions {
  maxListingPages?: number;
}

/**
 * The simplified FC2 lane.
 *
 * No detail fetches, no candidate queue, no store.
 * Filters on listing fields only: drops censored="有", not_found, trans-exclusion in title.
 * Emits scenes with listing releaseDate, duration, imageUrl.
 * Matcher is sxyprn+eporner (code-based search).
 */
export function createFc2CmadbStudio(options: Fc2StudioOptions = {}): SourceAdapter {
  const { maxListingPages = DEFAULT_FC2_MAX_LISTING_PAGES, ...clientOptions } = options;

  return {
    id: FC2CMADB_ID,
    name: "FC2 (fc2cmadb)",
    authority: {
      name: FC2CMADB_BASE,
      url: FC2_LISTING_URL,
      role: `authoritative catalogue: ${FC2_ANAL_TAG_NAME} tag listing`,
    },
    matcher: "sxyprn+eporner",
    async fetch(windowStart: string, ctx: SourceContext): Promise<SourceResult> {
      const client = createFc2Client(ctx, clientOptions);
      const now = ctx.now;

      const walk = await walkFc2Listing(client, windowStart, {
        maxPages: maxListingPages,
        log: ctx.log,
      });

      const scenes: RawScene[] = [];
      const excluded = new Set<string>();
      for (const record of walk.records) {
        if (!withinWindow(record.releaseDate, windowStart, now)) continue;

        // Positively excluded records are REPORTED, not merely skipped: sync
        // deletes only the ids named in `excludedSceneIds`, so a record the site
        // has since marked censored or removed is taken out of the catalogue
        // rather than lingering until it leaves the window.
        if (record.censored === "有") {
          excluded.add(record.videoId);
          continue;
        }
        if (record.notFound) {
          excluded.add(record.videoId);
          continue;
        }
        if (findTransExclusion(record.title)) continue;
        if (findSafetyExclusion(record.title)) continue;

        // An image set carries a count ("60枚") rather than a clock, so it has
        // no playable length and can never match an upload. Dropped here, the
        // way the detail-walk classifier dropped it.
        const durationSec = record.duration ? parseClockDuration(record.duration) : null;
        if (durationSec === null || durationSec <= 0) continue;

        scenes.push({
          sourceSceneId: record.videoId,
          title: record.title,
          releaseDate: record.releaseDate,
          performers: [],
          durationSec,
          thumbnailUrl: record.thumbnailUrl,
          releaseUrl: fc2RecordUrl(record.videoId),
          tags: [],
          source: FC2CMADB_BASE,
          studioId: `fc2cmadb-${record.videoId}`,
          studio: record.sellerName ?? "FC2 (fc2cmadb)",
          provenance: {
            source: FC2CMADB_BASE,
            sourceUrl: FC2_LISTING_URL,
            recordUrl: fc2RecordUrl(record.videoId),
            sourceSceneId: record.videoId,
            audit: { fc2Censorship: record.censored ?? "unmarked", fc2Tag: FC2_ANAL_TAG_NAME },
          },
        });
      }

      const verifiedEmpty = scenes.length === 0 && walk.reachedEnd && !walk.edgeStop;
      ctx.log("fc2: walk finished", {
        pages: walk.pages,
        candidates: walk.records.length,
        scenes: scenes.length,
        verifiedEmpty,
      });

      return {
        scenes,
        verifiedEmpty,
        ...(excluded.size ? { excludedSceneIds: [...excluded] } : {}),
      };
    },
  };
}
