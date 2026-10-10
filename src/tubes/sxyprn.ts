/**
 * The Sxyprn rung. A DIRECT fetch of the search page, filtered by duration.
 *
 * MEASURED 2026-10-10 against the live site, and the design follows from these
 * facts rather than from the old comment here:
 *
 *  - `https://sxyprn.com/<slug>.html` answers 200 to a plain server fetch with
 *    a browser User-Agent. No browser impersonation and no optional package.
 *  - The search genuinely filters: `emma-rosie` and `julesjordan` return
 *    different post sets.
 *  - A MULTI-TOKEN QUERY IS IGNORED past the first token - `emma-rosie`,
 *    `emma-rosie-jules-jordan` and `serene-siren-emma-rosie` all return the
 *    identical post set. So the query is ONE slug: the performer name. The
 *    studio is not a search input.
 *  - Every card carries a rendered `MM:SS` / `HH:MM:SS` duration.
 *  - Every card carries NO structured date - no <time>, no datetime, no
 *    JSON-LD, no uploadDate. Only a `(DD.MM.YYYY)` string inside some titles.
 *    This rung therefore filters on duration and ranks on identity, and does
 *    NOT apply the upload window. See `Risks` in the design plan.
 *  - The title lives in the anchor's `title=` attribute, not the text body.
 *  - Titles frequently embed the studio name as a prefix ("JulesJordan",
 *    "PornWorld", "ExploitedCollegeGirls"), so the studio name is an IDENTITY
 *    signal - it raises a candidate's tier - not a search term.
 *
 * WHY THE DATE GATE IS DROPPED HERE. The date exists only on the detail page,
 * and fetching one detail page per candidate is exactly the slow path this
 * redesign removes. The safety that the date window provided is now carried by
 * duration tolerance (1s, measured) plus the identity gate: a survivor must
 * name the scene by title, performer or studio to be linked at high confidence.
 * An unnamed duration survivor is still returned for the terminal fallback,
 * which marks it `low` - the same treatment every other rung gets.
 *
 * ponytail: the parser reads rendered HTML, which has no stability contract -
 * a site change fails as a silent empty pool. Re-run the live check when
 * matches drop.
 */
import { identityTier, type IdentityTier, type TubeCandidate } from "../core/matching.ts";
import type { Fetcher } from "../sources/types.ts";
import type { MatchScene } from "./types.ts";

const SEARCH_BASE = "https://sxyprn.com";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** 13 hex chars, e.g. `/post/6ab1a9bec8445.html`. */
export function validSxyprnUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      url.hostname === "sxyprn.com" &&
      !url.port &&
      /^\/post\/[a-f0-9]{13}\.html$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/** One parsed search card. */
export interface SxyprnCandidate {
  url: string;
  title: string;
  /** Seconds. Always present: a card without a readable clock is dropped. */
  duration: number;
  views: number | null;
}

export interface SxyprnSearchOptions {
  fetcher: Fetcher;
  /** Browser User-Agent. sxyprn answers 200 with this; it is the only header needed. */
  userAgent?: string;
}

/** `39:53` -> 2393, `1:14:19` -> 4479. Null when the text is not a clock. */
export function parseSxyprnDuration(value: string): number | null {
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map(Number);
  if (numbers.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const total = numbers.reduce((sum, n) => sum * 60 + n);
  return total > 0 ? total : null;
}

/** The slug the site expects: lowercase, non-alphanumerics collapsed to `-`. */
export function sxyprnSlug(value: string): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Parse the rendered card blocks out of a search page.
 *
 * sxyprn renders anchors with SINGLE quotes, so the href pattern accepts both.
 * A block is anchored on `class="post_time"`; the duration is the first
 * `MM:SS`/`HH:MM:SS` after it, and the views the first `<n>,<n> views`.
 */
export function parseSxyprnCards(html: string): SxyprnCandidate[] {
  const out: SxyprnCandidate[] = [];
  const blocks = html.split(/(?=post_time'|post_time")/);
  for (const block of blocks) {
    const anchor = block.match(/href=['"]\/post\/([a-f0-9]{13})\.html['"]/);
    if (!anchor) continue;
    const id = anchor[1]!;
    const titleMatch = block.match(/title='([^']*)'|title="([^"]*)"/);
    const title = (titleMatch?.[1] ?? titleMatch?.[2] ?? "").trim();
    const duration = parseSxyprnDuration(
      (block.match(/\b(\d{1,2}:\d{2}(?::\d{2})?)\b/) ?? [])[0] ?? "",
    );
    if (duration === null) continue;
    const viewsMatch = block.match(/([\d,]+)\s*views/i);
    const views = viewsMatch ? Number(viewsMatch[1]!.replace(/,/g, "")) : null;
    out.push({ url: `${SEARCH_BASE}/post/${id}.html`, title, duration, views });
  }
  return out;
}

/** Fetch one search page and parse its cards. Throws when the source cannot answer. */
export function createSxyprnSearch(options: SxyprnSearchOptions) {
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  return async function search(query: string): Promise<SxyprnCandidate[]> {
    const url = `${SEARCH_BASE}/${sxyprnSlug(query)}.html`;
    const html = await options.fetcher.text(url, {
      headers: { "user-agent": userAgent, accept: "text/html" },
    });
    return parseSxyprnCards(html).filter((c) => validSxyprnUrl(c.url));
  };
}

/** One duration survivor, including its identity tier for the shared ranking. */
export interface SxyprnMatch extends TubeCandidate {
  url: string;
  title: string;
  duration: number;
  views: number | null;
  identityTier: IdentityTier;
}

/**
 * Build the sxyprn lookup bound to one scene. Returns every duration survivor,
 * each carrying its identity tier. Throws only when the source itself could
 * not answer, so the caller can tell "the source is down" from "the source
 * found nothing" and move down the ladder without recording a false negative.
 */
export function createSxyprnLookup(
  search: (query: string) => Promise<SxyprnCandidate[]>,
  gate: { durationToleranceSec?: number },
): (scene: MatchScene) => Promise<SxyprnMatch[]> {
  const tolerance = gate.durationToleranceSec ?? 1;
  return async (scene) => {
    // The query is the FIRST performer only: a multi-token query is ignored by
    // the site past its first token (measured), so anything else would silently
    // widen the search rather than narrow it.
    const performer = scene.performers[0];
    if (!performer || !Number.isFinite(scene.durationSec)) return [];
    let cards: SxyprnCandidate[];
    try {
      cards = await search(performer);
    } catch (error) {
      // A source that could not answer is not a source that found nothing.
      throw new Error(`sxyprn search unavailable: ${(error as Error).message}`);
    }
    // Duration filter only. No date gate: cards carry no structured date.
    return cards
      .filter((c) => Math.abs(c.duration - (scene.durationSec ?? 0)) <= tolerance)
      .map((c) => ({
        url: c.url,
        title: c.title,
        duration: c.duration,
        views: c.views,
        identityTier: identityTier(scene, c.title),
      }));
  };
}
