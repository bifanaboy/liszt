import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  walkFc2Listing,
  createFc2Client,
  Fc2SourceError,
  Fc2ShapeError,
} from "../src/sources/fc2cmadb.ts";
import type { Fetcher } from "../src/sources/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const WINDOW_START = "2026-07-05";
const noSleep = async (): Promise<void> => {};

function stubFetcher(
  pages: Record<string, string | ((url: string) => string)>,
): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const keys = Object.keys(pages).sort((a, b) => b.length - a.length);
  return {
    calls,
    async fetch(url: string): Promise<Response> {
      calls.push(url);
      const key = keys.find((c) => url.startsWith(c));
      const page = key === undefined ? undefined : pages[key];
      if (page === undefined) return new Response("missing", { status: 404 });
      const body = typeof page === "function" ? page(url) : page;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    async text(url: string): Promise<string> {
      return (await this.fetch(url)).text();
    },
    async json<T>(url: string): Promise<T> {
      return (await this.fetch(url)).json() as T;
    },
  };
}

test("walk stops at window edge with cursor: edgeStop true", async () => {
  const page1 = fixture("fc2-anal-listing-page-1.html");
  const edgePage = fixture("fc2-anal-listing-edge-page.html");
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": page1,
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": edgePage,
  });
  const client = createFc2Client(
    { fetcher: { fetch: fetcher.fetch, text: fetcher.text, json: fetcher.json } },
    { sleep: noSleep },
  );
  const walk = await walkFc2Listing(client, WINDOW_START);
  assert.equal(walk.reachedEnd, true);
  assert.equal(walk.edgeStop, true);
  // 4 from page 1 + 1 out-of-window record from the edge page.
  assert.equal(walk.records.length, 5);
});

test("walk at end of listing: edgeStop false", async () => {
  const page1 = fixture("fc2-anal-listing-page-1.html");
  const finalHtml = fixture("fc2-anal-listing-final.html");
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": page1,
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": finalHtml,
  });
  const client = createFc2Client(
    { fetcher: { fetch: fetcher.fetch, text: fetcher.text, json: fetcher.json } },
    { sleep: noSleep },
  );
  const walk = await walkFc2Listing(client, WINDOW_START);
  assert.equal(walk.reachedEnd, true);
  assert.equal(walk.edgeStop, false);
  assert.equal(walk.records.length, 4);
});

test("repeated cursor throws Fc2ShapeError", async () => {
  const page = fixture("fc2-anal-listing-page-1.html");
  const fetcher = stubFetcher({ "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": page });
  const client = createFc2Client(
    { fetcher: { fetch: fetcher.fetch, text: fetcher.text, json: fetcher.json } },
    { sleep: noSleep },
  );
  await assert.rejects(() => walkFc2Listing(client, WINDOW_START), Fc2ShapeError);
});

test("page ceiling hit throws Fc2SourceError", async () => {
  const page = fixture("fc2-anal-listing-page-1.html");
  // The edge page has out-of-window records but a non-null next_cursor.
  // With maxPages: 1, the walk hits the ceiling before it can follow the cursor.
  const edgePage = fixture("fc2-anal-listing-edge-page.html");
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": page,
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": edgePage,
  });
  const client = createFc2Client(
    { fetcher: { fetch: fetcher.fetch, text: fetcher.text, json: fetcher.json } },
    { sleep: noSleep },
  );
  await assert.rejects(() => walkFc2Listing(client, WINDOW_START, { maxPages: 1 }), Fc2SourceError);
});
