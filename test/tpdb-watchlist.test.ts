import { test } from "node:test";
import assert from "node:assert/strict";
import { createTpdbWatchlistSource, cleanStudioName } from "../src/sources/tpdb-watchlist.ts";
import type { SourceContext } from "../src/sources/types.ts";

const studio = [{ studioId: "network-brazzers-anal", studio: "Brazzers", aliases: ["Brazzers"] }];
const scene = {
  id: "s1",
  title: "A Scene",
  date: "2026-10-03",
  duration: 600,
  url: "https://studio.test/scene/1",
  image: null,
  poster: null,
  performers: [{ name: "Alex" }],
  site: { name: "Brazzers" },
};

function context(responses: unknown[], opts: { now?: string; fail?: Error } = {}) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const ctx = {
    now: new Date(opts.now ?? "2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string, options?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: options?.headers });
        if (opts.fail) throw opts.fail;
        if (!responses.length) throw new Error("unexpected request");
        return responses.shift();
      },
    },
    log: () => {},
    mapWithConcurrency: async (items: unknown[], fn: (item: unknown) => unknown) =>
      Promise.all(items.map(fn)),
    mapIsolated: async (items: unknown[], fn: (item: unknown) => unknown) =>
      Promise.all(items.map(fn)),
  } as unknown as SourceContext;
  return { ctx, calls };
}

test("cleans names without collapsing different words", () => {
  assert.equal(cleanStudioName("  Bräzzers & Co. "), "brazzers co");
  assert.notEqual(cleanStudioName("Anal Quest"), cleanStudioName("Analquest"));
});

test("uses bearer authentication, paginates and emits mapped TPDB scenes", async () => {
  const { ctx, calls } = context([
    { data: [{ id: 7, name: "Brazzers" }], meta: { current_page: 1, last: 2 } },
    { data: [], meta: { current_page: 2, last: 2 } },
    { data: [scene], meta: { current_page: 1, last: 2 } },
    { data: [], meta: { current_page: 2, last: 2 } },
  ]);
  const result = await createTpdbWatchlistSource({
    token: "private-token",
    studios: studio,
  }).fetch("2026-10-01", ctx);
  assert.equal(calls[0]?.headers?.Authorization, "Bearer private-token");
  assert.match(calls[2]!.url, /site_id=7/);
  assert.equal(calls.length, 4);
  assert.equal(result.scenes[0]?.studioId, "network-brazzers-anal");
  assert.equal(result.scenes[0]?.durationSec, 600);
  assert.equal(result.scenes[0]?.releaseUrl, scene.url);
});

test("missing token, malformed pages and temporary failures throw without returning records", async () => {
  const noToken = createTpdbWatchlistSource({ studios: studio });
  await assert.rejects(noToken.fetch("2026-10-01", context([]).ctx), /token missing/);
  const source = createTpdbWatchlistSource({ token: "secret", studios: studio });
  await assert.rejects(
    source.fetch("2026-10-01", context([{ data: [], meta: { current_page: 2, last: 2 } }]).ctx),
    /inconsistent pagination/,
  );
  await assert.rejects(
    source.fetch("2026-10-01", context([], { fail: new Error("temporary outage") }).ctx),
    /temporary outage/,
  );
});

test("successful empty site and scene pages report a verified empty result", async () => {
  const { ctx } = context([{ data: [], meta: { current_page: 1, last: 1 } }]);
  const result = await createTpdbWatchlistSource({ token: "token", studios: studio }).fetch(
    "2026-10-01",
    ctx,
  );
  assert.deepEqual(result, { scenes: [], verifiedEmpty: true });
});

test("ambiguous TPDB studio names are excluded", async () => {
  const { ctx, calls } = context([
    {
      data: [{ id: 7, name: "Shared Studio", short_name: "shared" }],
      meta: { current_page: 1, last: 1 },
    },
  ]);
  const source = createTpdbWatchlistSource({
    token: "token",
    studios: [
      { studioId: "lane-a", studio: "Shared Studio", aliases: ["Shared Studio"] },
      { studioId: "lane-b", studio: "Shared Studio", aliases: ["Shared Studio"] },
    ],
  });
  const result = await source.fetch("2026-10-01", ctx);
  assert.deepEqual(result.scenes, []);
  assert.equal(calls.length, 1, "ambiguous matches do not fetch scene listings");
});
