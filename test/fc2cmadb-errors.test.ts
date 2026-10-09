import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFc2Client,
  Fc2RateLimitedError,
  Fc2SourceError,
  Fc2ShapeError,
} from "../src/sources/fc2cmadb.ts";
import type { Fetcher } from "../src/sources/types.ts";

const noSleep = async (): Promise<void> => {};

function makeFetcher(status: number, body: string): Fetcher {
  return {
    async fetch(_url: string): Promise<Response> {
      return new Response(body, {
        status,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    async text(_url: string): Promise<string> {
      return body;
    },
    async json<T>(_url: string): Promise<T> {
      return JSON.parse(body) as T;
    },
  };
}

test("429 throws Fc2RateLimitedError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(429, "rate limited") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2RateLimitedError);
});

test("404 throws Fc2SourceError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(404, "not found") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2SourceError);
});

test("410 throws Fc2SourceError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(410, "gone") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2SourceError);
});

test("500 throws Fc2SourceError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(500, "server error") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2SourceError);
});

test("missing Inertia payload throws Fc2ShapeError", async () => {
  const client = createFc2Client(
    { fetcher: makeFetcher(200, "<html>no payload</html>") },
    { sleep: noSleep },
  );
  await assert.rejects(() => client.listAnalTag(null), Fc2ShapeError);
});

test("malformed JSON payload throws Fc2ShapeError", async () => {
  const body = '<script data-page="app" type="application/json">not json</script>';
  const client = createFc2Client({ fetcher: makeFetcher(200, body) }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2ShapeError);
});

test("payload not an object throws Fc2ShapeError", async () => {
  const body = '<script data-page="app" type="application/json">[]</script>';
  const client = createFc2Client({ fetcher: makeFetcher(200, body) }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2ShapeError);
});

test("payload with no props throws Fc2ShapeError", async () => {
  const body = '<script data-page="app" type="application/json">{"component":"Tags/Show"}</script>';
  const client = createFc2Client({ fetcher: makeFetcher(200, body) }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2ShapeError);
});

test("an HTML-escaped payload is read through the unescape fallback", async () => {
  // A proxy or WAF that escapes the script body leaves valid JSON as entities.
  // The payload is tried as sent first, then unescaped, so this must parse.
  const escaped = `<script data-page="app" type="application/json">{&quot;component&quot;: &quot;Tags/Show&quot;, &quot;props&quot;: {&quot;tag_name&quot;: &quot;アナル&quot;, &quot;articles&quot;: {&quot;data&quot;: [], &quot;next_cursor&quot;: null}}, &quot;url&quot;: &quot;/tags/アナル&quot;, &quot;version&quot;: &quot;abc123&quot;}</script>`;
  const client = createFc2Client({ fetcher: makeFetcher(200, escaped) }, { sleep: noSleep });
  const listing = await client.listAnalTag(null);
  assert.deepEqual(listing.records, []);
  assert.equal(listing.nextCursor, null);
});

test("a title that literally contains &quot; is not rewritten by the fallback", async () => {
  // The payload is raw script text, so `&quot;` inside a title is five literal
  // characters. Unescaping first would rewrite the title; unescaping only after
  // a failed parse cannot.
  const raw = `<script data-page="app" type="application/json">{"component": "Tags/Show", "props": {"tag_name": "アナル", "articles": {"data": [{"title": "A &quot;quoted&quot; word", "video_id": 123, "release_date": "2026-10-02", "duration": "01:00:00", "censored": null, "not_found": null, "image_url": "https://example.test/x.jpg", "pivot": {"tag_id": 47}}], "next_cursor": null}}, "url": "/tags/アナル", "version": "abc123"}</script>`;
  const client = createFc2Client({ fetcher: makeFetcher(200, raw) }, { sleep: noSleep });
  const listing = await client.listAnalTag(null);
  assert.equal(listing.records[0]?.title, "A &quot;quoted&quot; word");
});
