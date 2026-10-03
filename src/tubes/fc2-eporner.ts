/**
 * FC2 resolution - a dedicated Eporner lane for the FC2 source.
 *
 * FC2 DOES NOT USE THE ORDINARY LADDER, and this module is why. The shared
 * matcher gates on identity evidence in a title (performer name, first token, a
 * scene-code stem) plus duration and upload window. An FC2 release is titled in
 * Japanese and its eporner reposts carry the release CODE in the title, so the
 * identity signal the ladder needs is often absent - and widening the shared
 * gates to admit it would weaken every other lane. This lane instead uses the one
 * fact an FC2 release has that nothing else does: a numeric release id the
 * uploader put in the title.
 *
 * THE ADMISSION RULE IS EXACT AND TOKEN-BOUNDED.
 *
 *   - The query is the bare numeric id (`4979341`). Not the FC2 URL, not an
 *     `FC2 PPV` prefix, not the Japanese title: a query carrying any of those
 *     returns a general search result whose top hits are unrelated.
 *   - A result is admitted only when its title contains that number as a WHOLE
 *     token. `FC2-PPV-4979341` and `[4979341]` admit; `14979341` and `49793410`
 *     do not, and neither does an unrelated video whose id contains it.
 *   - Related-video links are followed only under the same token test, so a
 *     single-hop search cannot drift into the uploader's other uploads.
 *
 * WHAT IS DELIBERATELY NOT GATED HERE. No performer match, no upload-date window,
 * and NO comparison against the FC2 scene's own duration. The code is the
 * identity, and a repost of an FC2 release is routinely uploaded weeks later and
 * split into files of different lengths - gating on those would reject the very
 * uploads this lane exists to find. The eporner duration is read for exactly one
 * decision, the multipart grouping below.
 *
 * MULTIPART IS EARNED, NEVER ASSUMED. FC2 releases are frequently uploaded as
 * several files. Two facts are required before any of them is called a part:
 * every grouped upload carries the SAME uploader, and every one has a DIFFERENT
 * eporner duration. Different uploaders means two unrelated releases that happen
 * to share a code; equal durations means the same file twice. When either fails,
 * every link is still stored and every link is still re-verified independently -
 * only the part numbers are withheld.
 *
 * ONE PAGE READ PER CANDIDATE. The search API supplies the title and the id but
 * no uploader and no dependable per-part length, and the watch page supplies all
 * three at once. So each admitted candidate is read exactly once, and that single
 * read decides uploader, duration and related links together. Re-reading it for
 * one field would double the lane's cost for nothing.
 *
 * LIVE CALIBRATION. The search API and a public watch page were checked on
 * 2026-10-03. Captured search data and relevant verbatim page elements live in
 * the fixtures. The main duration is Open Graph metadata; `title="Duration"`
 * spans belong to related cards and must not drive part numbering. The main
 * uploader comes from `vit-uploader`, not an arbitrary profile link. Missing
 * main-page duration or uploader evidence suppresses multipart labels.
 */
import { epornerVideoId, validEpornerUrl, type EpornerVideo } from "./eporner.ts";
import type { Fetcher } from "../sources/types.ts";

const EPORNER_SEARCH = "https://www.eporner.com/api/v2/video/search/";
const EPORNER_WATCH = "https://www.eporner.com";

export const FC2_EPORNER_RULE =
  "fc2-eporner: exact release code as a whole token in the title; uploader read per candidate; multipart only from one uploader with distinct durations";

export const DEFAULT_FC2_SEARCH_PAGES = 3;
export const DEFAULT_FC2_SEARCH_PAGE_SIZE = 20;
export const DEFAULT_FC2_RELATED_BOUND = 6;
/** Spacing between eporner reads for one FC2 scene. */
export const DEFAULT_FC2_EPORNER_INTERVAL_MS = 750;

/**
 * The numeric FC2 release id, from whichever spelling a record carries.
 *
 * Accepts the record URL the lane stores (`/articles/4986883`), the label form
 * (`FC2-PPV-4986883`) and a bare id. It deliberately does NOT accept an arbitrary
 * URL and scrape digits out of it: a query string carrying `id=14979341` names a
 * different release, and a permissive reader would resolve this scene to it.
 */
export function fc2ReleaseCode(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return text;
  const labelled = text.match(/FC2[\s_-]*PPV[\s_-]*(\d{4,})/i);
  if (labelled) return labelled[1] as string;
  const articles = text.match(/\/articles\/(\d{4,})(?:\b|$)/);
  if (articles) return articles[1] as string;
  return null;
}

/**
 * True when `code` appears in `text` as a WHOLE numeric token.
 *
 * The boundaries are DIGITS, not word characters: FC2 codes are digits and
 * repost titles glue them to latin words (`FC2-PPV-4979341`, `[4979341]`), so a
 * `\b` boundary would reject the very titles this lane needs while still letting
 * `14979341` and `49793410` through.
 */
export function titleContainsExactCode(title: string, code: string): boolean {
  if (!/^\d+$/.test(code)) return false;
  return new RegExp(`(?<!\\d)${code}(?!\\d)`).test(String(title ?? ""));
}

/** Query the search API with the bare code and explicit page bounds. */
export function fc2EpornerSearchUrl(code: string, page: number, perPage: number): string {
  const url = new URL(EPORNER_SEARCH);
  // ONLY the numeric id goes in `query`; everything else here is structural
  // paging. `lq=0` because the API otherwise defaults to INCLUDING low-quality
  // uploads, the mistake the deleted open-search rung documented.
  url.searchParams.set("query", code);
  url.searchParams.set("per_page", String(perPage));
  url.searchParams.set("page", String(page));
  url.searchParams.set("lq", "0");
  url.searchParams.set("format", "json");
  return url.href;
}

/** Build a canonical watch URL for a discovered Eporner video ID. */
export const fc2EpornerWatchUrl = (id: string): string => `${EPORNER_WATCH}/video-${id}/`;

export interface Fc2EpornerCandidate {
  id: string;
  url: string;
  title: string;
  /** eporner's duration. Never compared with the FC2 scene's duration. */
  durationSec: number | null;
  /** Read from the candidate's own page; null when the page could not be read. */
  uploader: string | null;
}

/** Accept positive numeric duration evidence, rounded to whole seconds. */
function positiveSeconds(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/** The v2 search body is `{videos: [...]}`; `video/id` answers a bare array. */
function extractVideoRows(body: unknown): EpornerVideo[] {
  if (Array.isArray(body)) return body as EpornerVideo[];
  if (body && typeof body === "object") {
    const videos = (body as { videos?: unknown }).videos;
    if (Array.isArray(videos)) return videos as EpornerVideo[];
  }
  return [];
}

/**
 * Read one search page and admit only the rows whose title carries the code.
 *
 * An empty admitted set means "no exact-code hit on the pages read". It is NOT
 * read as a verified absence: the API reports no reliable total for a code
 * query, so the caller treats it as no match and the lane says nothing about
 * exhaustiveness.
 */
export function parseFc2EpornerSearch(body: unknown, code: string): Fc2EpornerCandidate[] {
  const out: Fc2EpornerCandidate[] = [];
  const seen = new Set<string>();
  for (const row of extractVideoRows(body)) {
    const id = row?.id === undefined || row?.id === null ? "" : String(row.id).trim();
    const title = typeof row?.title === "string" ? row.title : "";
    if (!id || !title) continue;
    if (typeof row.url !== "string" || !validEpornerUrl(row.url)) continue;
    if (seen.has(row.url) || !epornerVideoId(row.url)) continue;
    if (!titleContainsExactCode(title, code)) continue;
    seen.add(row.url);
    out.push({
      id,
      url: row.url,
      title,
      durationSec: positiveSeconds(row.length_sec),
      uploader: null,
    });
  }
  return out;
}

/**
 * The uploading account, from a candidate's watch page.
 *
 * Neither the search response nor `video/id` carries an uploader - the reason
 * the trusted-pool rung indexes profiles in the first place. The watch page is
 * where it appears, as a `/profile/<account>/` link. Null means "not read", and
 * null is never a guess: an unknown uploader cannot join a multipart group.
 */
/**
 * Comments removed before any page is read.
 *
 * A page's own source comment can contain the very markup a rule looks for -
 * this file's fixtures say so in their headers. Reading comments as if they were
 * rendered content is how a parser ends up confident about something a reader
 * would never see, so they are dropped once, up front.
 */
function stripComments(html: string): string {
  return String(html ?? "").replace(/<!--[\s\S]*?-->/g, " ");
}

/** The main video's uploader block, excluding related-card and navigation links. */
export function epornerUploaderFromPage(html: string): string | null {
  const block =
    stripComments(html).match(
      /<li\b[^>]*class=["'][^"']*\bvit-uploader\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/i,
    )?.[1] ?? "";
  const account = block.match(
    /<a\b[^>]*href=["'][^"']*\/profile\/([A-Za-z0-9._~-]+)\/[^"']*["'][^>]*>/i,
  )?.[1];
  return account ?? null;
}

/** Main-video Open Graph duration; card durations belong to related uploads. */
export function epornerDurationFromPage(html: string): number | null {
  for (const meta of stripComments(html).matchAll(/<meta\b[^>]*>/gi)) {
    if (!/\bproperty=["']og:duration["']/i.test(meta[0])) continue;
    const seconds = meta[0].match(/\bcontent=["'](\d+)["']/i)?.[1];
    return seconds ? positiveSeconds(seconds) : null;
  }
  return null;
}

/**
 * Related-video ids from one candidate page, token-gated and bounded.
 *
 * A watch page links many other videos, virtually all of them unrelated. Only an
 * anchor whose slug or link text carries the exact code is followed, which is
 * what stops a one-hop search turning into a walk of somebody's whole account.
 * The seed candidate is excluded so a page cannot re-offer itself.
 */
export function relatedFc2VideoIds(
  html: string,
  code: string,
  { bound = 6, exclude = new Set<string>() }: { bound?: number; exclude?: Set<string> } = {},
): string[] {
  const source = stripComments(html);
  const anchor =
    /<a\b[^>]*href=["']([^"']*\/(?:video-|hd-porn\/)([A-Za-z0-9]+)[^"']*)["'][^>]*>([\s\S]{0,400}?)<\/a>/g;
  const ids: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while (ids.length < bound && (match = anchor.exec(source)) !== null) {
    const id = match[2] as string;
    if (!id || seen.has(id) || exclude.has(id)) continue;
    // The slug IS the urlified title, so the code survives it; the link text is
    // checked too because a short slug can drop the leading digits.
    const haystack = `${(match[1] as string).replace(/[-_/]+/g, " ")} ${(match[3] as string).replace(/<[^>]+>/g, " ")}`;
    if (!titleContainsExactCode(haystack, code)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Assign part numbers, or decline to - all-or-nothing across the admitted set.
 *
 * All-or-nothing is the part that is easy to get wrong: numbering two of three
 * uploads when the third turns out to be a different uploader produces a scene
 * that claims a verified multipart release and is not one. So the group must be
 * uniform in uploader, and every duration must be present and pairwise distinct.
 * Anything else leaves every link part-less, and the links are still kept.
 */
export function groupMultipart(candidates: readonly Fc2EpornerCandidate[]): Map<string, number> {
  const parts = new Map<string, number>();
  if (candidates.length < 2) return parts;
  const uploaders = new Set(candidates.map((candidate) => candidate.uploader ?? ""));
  if (uploaders.size !== 1 || uploaders.has("")) return parts;
  const durations = candidates.map((candidate) => candidate.durationSec);
  if (durations.some((duration) => duration === null)) return parts;
  if (new Set(durations).size !== durations.length) return parts;
  // Ordered by duration so "Part 1" is deterministically the shortest file.
  const ordered = [...candidates].sort(
    (a, b) => (a.durationSec ?? 0) - (b.durationSec ?? 0) || a.url.localeCompare(b.url),
  );
  ordered.forEach((candidate, index) => parts.set(candidate.url, index + 1));
  return parts;
}

export interface Fc2ResolverOptions {
  searchPages?: number;
  searchPageSize?: number;
  /** Hard cap on related-video fetches, across breadth and depth alike. */
  relatedBound?: number;
  minIntervalMs?: number;
  /** Injected so tests exercise the walk without waiting out the pacing. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Fc2Link {
  url: string;
  uploader: string | null;
  /** Present only for a verified multipart group. */
  part?: number;
}

export interface Fc2LookupResult {
  links: Fc2Link[];
  /** The code looked up, or null when the record carried none. */
  code: string | null;
  pagesRead: number;
  /** Candidate pages read: the search result pages plus every candidate page. */
  candidatePagesRead: number;
  relatedFollowed: number;
  /** Why the lane produced no links, when it tried and failed. */
  error?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

/**
 * Resolve one FC2 release code to its verified eporner uploads.
 *
 * Failures return NO links rather than throwing. A scene keeps its last-good
 * links, and a lookup that could not read its evidence has no safe way to produce
 * a link in the first place; throwing would fail the whole cycle's linking stage
 * over one unresolvable release.
 */
export function createFc2EpornerResolver(
  fetcher: Fetcher,
  {
    searchPages = DEFAULT_FC2_SEARCH_PAGES,
    searchPageSize = DEFAULT_FC2_SEARCH_PAGE_SIZE,
    relatedBound = DEFAULT_FC2_RELATED_BOUND,
    minIntervalMs = DEFAULT_FC2_EPORNER_INTERVAL_MS,
    sleep = defaultSleep,
  }: Fc2ResolverOptions = {},
) {
  const gate = { at: 0 };
  let readTail: Promise<void> = Promise.resolve();

  /** One paced read. Null means "unreadable", never "absent". */
  function read(url: string): Promise<{ body: string; error?: string } | { error: string }> {
    const result = readTail.then(() => pacedRead(url));
    readTail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Serialize reads across scenes so concurrent waiters cannot start together. */
  async function pacedRead(
    url: string,
  ): Promise<{ body: string; error?: string } | { error: string }> {
    const wait = minIntervalMs - (Date.now() - gate.at);
    if (wait > 0) await sleep(wait);
    gate.at = Date.now();
    try {
      const response = await fetcher.fetch(url, {
        headers: { accept: "application/json,text/html" },
      });
      if (!response.ok) return { error: `${url} -> HTTP ${response.status}` };
      const type = (response.headers.get("content-type") ?? "").toLowerCase();
      // An anti-bot challenge answers HTTP 200 with a JavaScript body. Trusting
      // that would manufacture a verified-empty search, so the content type is
      // checked before the body is allowed to speak for the API.
      if (type && !type.includes("json") && !type.includes("html")) {
        return { error: `${url} -> unusable body (${type})` };
      }
      return { body: await response.text() };
    } catch (error) {
      return { error: `${url} -> ${(error as Error).message}` };
    }
  }

  /** Read one candidate's own page: uploader, duration and related links. */
  async function hydrateCandidate(
    candidate: Fc2EpornerCandidate,
    code: string,
    related: string[],
    budget: number,
  ): Promise<string | null> {
    const page = await read(candidate.url);
    if (!("body" in page)) return page.error;
    const title = titleFromPage(page.body);
    if (!title || !titleContainsExactCode(title, code))
      return `${candidate.url} -> no readable exact-code video`;
    candidate.uploader = epornerUploaderFromPage(page.body);
    // Only the page's own duration can establish parts: the search row
    // describes the upload, the page describes the file, and multipart is a claim
    // about files.
    candidate.durationSec = epornerDurationFromPage(page.body);
    if (related.length < budget) {
      related.push(
        ...relatedFc2VideoIds(page.body, code, {
          bound: budget - related.length,
          exclude: new Set([candidate.id]),
        }),
      );
    }
    return null;
  }

  /** Collect exact-code uploads and verified multipart evidence within the request bounds. */
  return async function lookup(code: unknown): Promise<Fc2LookupResult> {
    const trimmed = fc2ReleaseCode(code);
    if (!trimmed)
      return { links: [], code: null, pagesRead: 0, candidatePagesRead: 0, relatedFollowed: 0 };

    const pages = Math.max(1, Math.floor(searchPages));
    const admitted = new Map<string, Fc2EpornerCandidate>();
    let pagesRead = 0;
    const searchRowsSeen = new Set<string>();
    let firstError: string | null = null;
    for (let page = 1; page <= pages; page += 1) {
      const result = await read(fc2EpornerSearchUrl(trimmed, page, searchPageSize));
      if (!("body" in result)) {
        firstError = firstError ?? result.error;
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.body);
      } catch {
        firstError = firstError ?? "the eporner search response was not JSON";
        break;
      }
      pagesRead += 1;
      const rawRows = extractVideoRows(parsed);
      if (!rawRows.length) break;
      const newRows = rawRows.filter((row) => !searchRowsSeen.has(String(row.id)));
      for (const row of rawRows) searchRowsSeen.add(String(row.id));
      if (!newRows.length) break;
      const rows = parseFc2EpornerSearch(parsed, trimmed);
      for (const row of rows) {
        if (admitted.has(row.id)) continue;
        admitted.set(row.id, row);
      }
    }
    if (!pagesRead) {
      return {
        links: [],
        code: trimmed,
        pagesRead: 0,
        candidatePagesRead: 0,
        relatedFollowed: 0,
        ...(firstError ? { error: firstError } : {}),
      };
    }

    const related: string[] = [];
    let candidatePagesRead = 0;
    for (const candidate of admitted.values()) {
      const error = await hydrateCandidate(candidate, trimmed, related, Math.max(0, relatedBound));
      candidatePagesRead += 1;
      firstError = firstError ?? error;
      if (error) admitted.delete(candidate.id);
    }

    // The bounded related walk. Every id it reaches is fetched, and a fetched
    // candidate joins the set only when its OWN page carries the code, so a
    // related link is admitted on the same evidence as a search row.
    let relatedFollowed = 0;
    const walked = new Set(admitted.keys());
    while (related.length > 0 && relatedFollowed < relatedBound) {
      const id = related.shift() as string;
      if (walked.has(id)) continue;
      walked.add(id);
      relatedFollowed += 1;
      const page = await read(fc2EpornerWatchUrl(id));
      candidatePagesRead += 1;
      if (!("body" in page)) {
        firstError = firstError ?? page.error;
        continue;
      }
      const title = titleFromPage(page.body);
      if (title === null || !titleContainsExactCode(title, trimmed)) continue;
      const candidate: Fc2EpornerCandidate = {
        id,
        url: fc2EpornerWatchUrl(id),
        title,
        durationSec: epornerDurationFromPage(page.body),
        uploader: epornerUploaderFromPage(page.body),
      };
      if (!admitted.has(candidate.id)) admitted.set(candidate.id, candidate);
      const remaining = Math.max(0, relatedBound - relatedFollowed - related.length);
      related.push(
        ...relatedFc2VideoIds(page.body, trimmed, { bound: remaining, exclude: walked }),
      );
    }

    const final = [...admitted.values()];
    const parts = groupMultipart(final);
    return {
      links: final.map((candidate) => ({
        url: candidate.url,
        uploader: candidate.uploader,
        ...(parts.has(candidate.url) ? { part: parts.get(candidate.url) as number } : {}),
      })),
      code: trimmed,
      pagesRead,
      candidatePagesRead,
      relatedFollowed,
      ...(firstError ? { error: firstError } : {}),
    };
  };
}

/**
 * The title a watch page renders for its video, or null when it renders none.
 *
 * Only a page whose heading carries the code is accepted, so this doubles as the
 * related-walk's evidence test and never has to be trusted separately.
 */
export function titleFromPage(html: string): string | null {
  const heading = stripComments(html).match(/<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i)?.[1];
  const text = (heading ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}
