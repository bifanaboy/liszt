import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractInertiaPage,
  FC2_ANAL_TAG_NAME,
} from "../src/sources/fc2cmadb.ts";
import { findTransExclusion } from "../src/sources/trans-exclusion.ts";
import type { Fetcher, SourceContext } from "../src/sources/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const NOW = new Date("2026-10-03T00:00:00Z");
const WINDOW_START = "2026-07-05";

function stubFetcher(pages: Record<string, string | ((url: string) => string)>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const keys = Object.keys(pages).sort((a, b) => b.length - a.length);
  return {
    calls,
    async fetch(url: string): Promise<Response> {
      calls.push(url);
      const key = keys.find((candidate) => url.startsWith(candidate));
      const page = key === undefined ? undefined : pages[key];
      if (page === undefined) return new Response("missing", { status: 404 });
      const body = typeof page === "function" ? page(url) : page;
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
    async text(url: string): Promise<string> { return (await this.fetch(url)).text(); },
    async json<T>(url: string): Promise<T> { return (await this.fetch(url)).json() as T; },
  };
}

function context(fetcher: Fetcher, now = NOW): SourceContext {
  return {
    fetcher, now,
    log: () => {},
    mapWithConcurrency: (items, task) => Promise.all(items.map(task)),
    mapIsolated: (items, task) => Promise.all(items.map(task)),
  };
}

async function simpleFc2Fetch(windowStart: string, ctx: SourceContext): Promise<{
  scenes: Array<{ videoId: string; title: string; releaseDate: string; duration: string; imageUrl: string }>;
  verifiedEmpty: boolean;
}> {
  const baseUrl = `https://fc2cmadb.com/tags/${encodeURIComponent(FC2_ANAL_TAG_NAME)}`;
  const boundary = new Date(`${windowStart}T00:00:00Z`).getTime();
  const scenes: Array<{ videoId: string; title: string; releaseDate: string; duration: string; imageUrl: string }> = [];
  let cursor: string | null = null;

  for (let page = 1; page <= 40; page++) {
    const url = cursor ? `${baseUrl}?cursor=${encodeURIComponent(cursor)}` : baseUrl;
    const html = await ctx.fetcher.text(url);
    const pageData = extractInertiaPage(html);
    if (pageData.props.tag_name !== FC2_ANAL_TAG_NAME) throw new Error(`expected ${FC2_ANAL_TAG_NAME} tag listing`);
    const paginator = pageData.props.articles as { data: Array<Record<string, unknown>>; next_cursor: string | null };
    if (!paginator || !Array.isArray(paginator.data)) throw new Error("no articles paginator");
    const articles = paginator.data;
    let inWindowCount = 0;
    for (const article of articles) {
      const releaseDate = String(article.release_date ?? "");
      const at = Date.parse(`${releaseDate}T00:00:00Z`);
      if (Number.isFinite(at) && at >= boundary) {
        inWindowCount++;
        if (article.censored === "有") continue;
        if (article.not_found) continue;
        if (findTransExclusion(String(article.title ?? ""))) continue;
        scenes.push({
          videoId: String(article.video_id),
          title: String(article.title ?? ""),
          releaseDate,
          duration: String(article.duration ?? ""),
          imageUrl: String(article.image_url ?? ""),
        });
      }
    }
    if (!inWindowCount) break;
    const nextCursor = paginator.next_cursor;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { scenes, verifiedEmpty: scenes.length === 0 };
}

test("simple lane: emits scenes, drops censored and trans", async () => {
  const listingHtml = fixture("fc2-anal-listing-page-1.html");
  const finalHtml = fixture("fc2-anal-listing-final.html");
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": listingHtml,
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": finalHtml,
  });
  const result = await simpleFc2Fetch(WINDOW_START, context(fetcher));
  assert.equal(result.scenes.length, 3);
  assert.equal(result.verifiedEmpty, false);
  const ids = result.scenes.map(s => s.videoId).sort();
  assert.deepEqual(ids, ["4986048", "4986794", "4986883"]);
  const first = result.scenes.find(s => s.videoId === "4986883");
  assert.ok(first);
  assert.equal(first.title.includes("托卵実録"), true);
  assert.equal(first.releaseDate, "2026-10-02");
  assert.equal(first.duration, "01:02:08");
  assert.ok(first.imageUrl.includes("contents-thumbnail2.fc2.com"));
});

test("simple lane: empty window is verified empty", async () => {
  const oldListing = fixture("fc2-anal-listing-final.html");
  const fetcher = stubFetcher({ "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": oldListing });
  const result = await simpleFc2Fetch(WINDOW_START, context(fetcher));
  assert.equal(result.scenes.length, 0);
  assert.equal(result.verifiedEmpty, true);
});
