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
