/**
 * The direct-URL-scrape category: a listing page, walked with `rel=next`, then
 * one fetch per video page for its JSON-LD `VideoObject` (falling back to the
 * per-host studio-site recipe).
 *
 * This is the machinery behind Bang! Originals and Maximo Garcia. It exists as
 * a shared layer because both have the same shape and the same two properties
 * that matter:
 *
 *  - A shape change must FAIL LOUDLY. `parseListing` and `parseVideoPage`
 *    throw rather than returning fewer records, because a silent partial parse
 *    would look exactly like "the studio released nothing this week" and the
 *    retention rule would then delete the lane's real records.
 *  - The listing's own dates bound the per-page fan-out, so a sync stays
 *    inside the rolling window instead of walking a whole archive.
 */
import type { RawScene, SourceAdapter, SourceContext, SourceResult } from "./types.ts";

export interface ListingEntry {
  releaseUrl: string;
  releaseDate?: string;
  /** A listing-supplied title, when the markup carries one. */
  title?: string;
}

export interface DirectScrapeOptions {
  id: string;
  name: string;
  /** Hosts the listing and its video pages may live on. */
  allowedHosts: readonly string[];
  /** Empty means "not configured" - the source reports that calmly. */
  listingUrl: string | undefined;
  windowDays: number;
  matcher: string | null;
  creatorStudio?: boolean;
  role?: string;
  /** The env var named in the "not configured" error. */
  configVariable?: string;
  parseListing(html: string, base: string): ListingEntry[];
  parseVideoPage(html: string, entry: ListingEntry, base: string): RawScene;
  /** Hard bound on listing pages walked. */
  maxPages?: number;
}

/** A named, calm status for a lane that needs operator configuration. */
export class NotConfiguredError extends Error {
  constructor(what: string, variable: string) {
    super(`${what} is not configured (set ${variable})`);
    this.name = "NotConfiguredError";
  }
}

function isAllowed(url: URL, allowedHosts: readonly string[]): boolean {
  return allowedHosts.includes(url.hostname.toLowerCase());
}

function dateOnly(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
}

function decodeHtml(value = ""): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export { decodeHtml };

/** `rel=next`, resolved against the page it was found on. */
export function nextPageUrl(html: string, current: string): string | undefined {
  const tag = html.match(/<link[^>]+rel=["'][^"']*\bnext\b[^"']*["'][^>]*>/i)?.[0];
  if (!tag) return undefined;
  const target =
    tag.match(/href=["']([^"']+)["']/i)?.[1] ??
    tag.match(/content=["']([^"']+)["']/i)?.[1];
  if (!target) return undefined;
  try {
    return new URL(decodeHtml(target), current).href;
  } catch {
    return undefined;
  }
}

async function fetchHtml(
  url: string,
  ctx: SourceContext,
  allowedHosts: readonly string[],
  label: string,
): Promise<string> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`${label}: ${url} is not a valid URL`);
  }
  if (!isAllowed(target, allowedHosts)) {
    throw new Error(`${label}: refusing to fetch off-allowlist host ${target.hostname}`);
  }
  let current = target.href;
  for (let hop = 0; hop < 10; hop += 1) {
    const response = await ctx.fetcher.fetch(current, {
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) break;
      const next = new URL(location, current);
      if (!isAllowed(next, allowedHosts)) {
        throw new Error(`${label}: redirect left the allowlist (${next.hostname})`);
      }
      current = next.href;
      continue;
    }
    if (!response.ok) {
      throw new Error(`${label} fetch failed with HTTP ${response.status} for ${current}`);
    }
    return response.text();
  }
  throw new Error(`${label}: too many redirects starting at ${url}`);
}

export function createDirectScrapeStudio(options: DirectScrapeOptions): SourceAdapter {
  const {
    id,
    name,
    allowedHosts,
    listingUrl,
    windowDays,
    matcher,
    creatorStudio = false,
    role = "authoritative catalogue",
    configVariable = "the lane's listing URL",
    parseListing,
    parseVideoPage,
    maxPages = 40,
  } = options;

  return {
    id,
    name,
    windowDays,
    authority: { name, url: listingUrl ?? "not configured", role },
    matcher,
    creatorStudio,
    async fetch(windowStart, ctx): Promise<SourceResult> {
      if (!listingUrl) throw new NotConfiguredError(name, configVariable);
      const base = new URL(listingUrl).origin;
      const earliest = new Date(`${windowStart}T00:00:00Z`);

      const listings = new Map<string, ListingEntry>();
      let pageUrl: string | undefined = listingUrl;
      const visited = new Set<string>();
      for (let page = 0; page < maxPages && pageUrl && !visited.has(pageUrl); page += 1) {
        visited.add(pageUrl);
        const html = await fetchHtml(pageUrl, ctx, allowedHosts, name);
        // A listing shape change throws here, which is the loud failure the
        // retention rule depends on.
        const entries = parseListing(html, base);
        for (const entry of entries) {
          const date = dateOnly(entry.releaseDate);
          listings.set(entry.releaseUrl, { ...entry, ...(date ? { releaseDate: date } : {}) });
        }
        const hasRecent = entries.some((entry) => {
          const date = dateOnly(entry.releaseDate);
          return date !== undefined && new Date(`${date}T00:00:00Z`) >= earliest;
        });
        const next = nextPageUrl(html, pageUrl);
        pageUrl = next && hasRecent ? next : undefined;
      }

      // Only pages whose listing date is inside the window get hydrated.
      const queue = [...listings.values()].filter((entry) => {
        if (!entry.releaseDate) return false;
        const date = new Date(`${entry.releaseDate}T00:00:00Z`);
        return date >= earliest && date <= ctx.now;
      });
      if (!queue.length) {
        // An empty window is only trusted when the listing itself was readable
        // and carried entries; otherwise the scrape failed silently upstream.
        return { scenes: [], verifiedEmpty: listings.size > 0 };
      }

      const scenes = await ctx.mapWithConcurrency(queue, async (entry) => {
        const html = await fetchHtml(entry.releaseUrl, ctx, allowedHosts, name);
        return parseVideoPage(html, entry, base);
      });
      return { scenes, verifiedEmpty: scenes.length === 0 };
    },
  };
}
