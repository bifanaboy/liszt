import { test } from "node:test";
import assert from "node:assert/strict";
import { createTpdbWatchlistSource, cleanStudioName } from "../src/sources/tpdb-watchlist.ts";
import { FetchError } from "../src/core/fetcher.ts";
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
  tags: [{ name: "Anal" }],
  site: { name: "Brazzers" },
};
const site = { id: 7, name: "Brazzers", short_name: "brazzers" };
const page = (data: unknown[], lastPage = 1) => ({
  data,
  meta: { current_page: 1, last_page: lastPage },
});

/** Routes a request by URL so a test states only what it cares about. */
function context(
  routes: { site?: unknown; scenes?: unknown[]; lookupMisses?: string[] },
  opts: { now?: string; fail?: Error } = {},
) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const misses = new Set(routes.lookupMisses ?? []);
  const ctx = {
    now: new Date(opts.now ?? "2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string, options?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: options?.headers });
        if (opts.fail) throw opts.fail;
        const parsed = new URL(url);
        if (parsed.pathname.startsWith("/sites/")) {
          const identifier = decodeURIComponent(parsed.pathname.slice("/sites/".length));
          const absent = misses.has(identifier) || routes.site === undefined;
          if (absent) throw new FetchError(`GET ${url} -> 404`, "definitive", 404);
          return { data: routes.site };
        }
        if (parsed.pathname === "/scenes") {
          if (!routes.scenes) throw new Error("unexpected scene request");
          return page(routes.scenes);
        }
        throw new Error(`unexpected request ${url}`);
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

const sceneCalls = (calls: Array<{ url: string }>) =>
  calls.filter((call) => new URL(call.url).pathname === "/scenes");
const siteCalls = (calls: Array<{ url: string }>) =>
  calls.filter((call) => new URL(call.url).pathname.startsWith("/sites/"));

test("cleans names without collapsing different words", () => {
  assert.equal(cleanStudioName("  Bräzzers & Co. "), "brazzers co");
  assert.notEqual(cleanStudioName("Anal Quest"), cleanStudioName("Analquest"));
});

test("looks a studio up directly and emits mapped TPDB scenes", async () => {
  const { ctx, calls } = context({ site, scenes: [scene] });
  const result = await createTpdbWatchlistSource({
    token: "private-token",
    studios: studio,
  }).fetch("2026-10-01", ctx);
  assert.equal(calls[0]?.headers?.Authorization, "Bearer private-token");
  assert.equal(new URL(calls[0]!.url).pathname, "/sites/brazzers");
  assert.equal(siteCalls(calls).length, 1, "one direct lookup per studio, not a catalogue walk");
  const listing = sceneCalls(calls)[0]!.url;
  assert.match(listing, /site_id=7/);
  assert.match(listing, /date=2026-10-01/);
  assert.match(listing, /date_operation=%3E%3D/);
  assert.equal(result.scenes[0]?.studioId, "network-brazzers-anal");
  assert.equal(result.scenes[0]?.durationSec, 600);
  assert.equal(result.scenes[0]?.releaseUrl, scene.url);
});

test("a multi-word alias resolves the site TPDB spells with spaces", async () => {
  const { ctx, calls } = context({
    site: { id: 1052, name: "Elegant Angel", short_name: "elegantangel" },
    scenes: [scene],
  });
  await createTpdbWatchlistSource({
    token: "token",
    studios: [{ studioId: "lane", studio: "Elegant Angel", aliases: ["Elegant Angel"] }],
  }).fetch("2026-10-01", ctx);
  assert.equal(new URL(calls[0]!.url).pathname, "/sites/elegant%20angel");
  assert.match(sceneCalls(calls)[0]!.url, /site_id=1052/);
});

test("a lookup that returns a differently-named site is rejected, not trusted", async () => {
  // /sites/{identifier} resolves loosely; the response must still name an alias
  // of the studio being looked up or the lane would ingest another studio's scenes.
  const { ctx } = context({
    site: { id: 999, name: "Someone Else Entirely", short_name: "someoneelse" },
    scenes: [scene],
  });
  await assert.rejects(
    createTpdbWatchlistSource({ token: "token", studios: studio }).fetch("2026-10-01", ctx),
    /matched no configured studio names/,
  );
});

test("a studio TPDB does not carry is reported unmatched, and the rest still run", async () => {
  const { ctx, calls } = context({ site, scenes: [scene], lookupMisses: ["jules jordan"] });
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [
      ...studio,
      { studioId: "lane-missing", studio: "Jules Jordan", aliases: ["Jules Jordan"] },
    ],
  }).fetch("2026-10-01", ctx);
  assert.equal(result.scenes.length, 1, "the matched studio still contributes");
  assert.equal(siteCalls(calls).length, 2, "the absent studio is looked up once, then skipped");
  assert.equal(sceneCalls(calls).length, 1);
});

test("missing token and temporary failures throw without returning records", async () => {
  const noToken = createTpdbWatchlistSource({ studios: studio });
  await assert.rejects(noToken.fetch("2026-10-01", context({}).ctx), /token missing/);
  const source = createTpdbWatchlistSource({ token: "secret", studios: studio });
  await assert.rejects(
    source.fetch(
      "2026-10-01",
      context({}, { fail: new FetchError("GET /sites/brazzers -> 503", "inconclusive", 503) }).ctx,
    ),
    /503/,
    "a failing lookup propagates; it must not read as an absent studio",
  );
});

test("a matched studio with no in-window scenes reports a verified empty result", async () => {
  const result = await createTpdbWatchlistSource({ token: "token", studios: studio }).fetch(
    "2026-10-01",
    context({ site, scenes: [] }).ctx,
  );
  assert.deepEqual(result, { scenes: [], verifiedEmpty: true });
});

test("no matching site name is a source error, not a verified empty result", async () => {
  await assert.rejects(
    createTpdbWatchlistSource({ token: "token", studios: studio }).fetch(
      "2026-10-01",
      context({ scenes: [scene] }).ctx,
    ),
    /matched no configured studio names/,
  );
});

test("ambiguous TPDB studio names are excluded", async () => {
  const { ctx, calls } = context({ site, scenes: [scene] });
  const source = createTpdbWatchlistSource({
    token: "token",
    studios: [
      { studioId: "lane-a", studio: "Shared Studio", aliases: ["Shared Studio"] },
      { studioId: "lane-b", studio: "Shared Studio", aliases: ["Shared Studio"] },
    ],
  });
  await assert.rejects(source.fetch("2026-10-01", ctx), /matched no configured studio names/);
  assert.equal(sceneCalls(calls).length, 0, "ambiguous matches fetch no scene listings");
});

test("three-way aliases stay ambiguous and an ambiguous full name cannot fall back to short name", async () => {
  const { ctx, calls } = context({ site, scenes: [scene] });
  const source = createTpdbWatchlistSource({
    token: "token",
    studios: [
      { studioId: "lane-a", studio: "A", aliases: ["Shared Studio", "lane-a"] },
      { studioId: "lane-b", studio: "B", aliases: ["Shared Studio"] },
      { studioId: "lane-c", studio: "C", aliases: ["Shared Studio"] },
    ],
  });
  await assert.rejects(source.fetch("2026-10-01", ctx), /matched no configured studio names/);
  assert.equal(sceneCalls(calls).length, 0);
});

test("tagged lanes retain only TPDB scenes carrying every requested tag", async () => {
  const taggedScene = { ...scene, tags: [{ name: "Anal" }, { name: "Creampie" }] };
  const untaggedScene = { ...scene, id: "s2", tags: [{ name: "Anal" }] };
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [{ ...studio[0]!, tags: ["anal", "creampie"] }],
  }).fetch("2026-10-01", context({ site, scenes: [taggedScene, untaggedScene] }).ctx);
  assert.deepEqual(
    result.scenes.map((entry) => entry.sourceSceneId),
    ["s1"],
  );
});

test("reuses the matched site map on later refreshes", async () => {
  const { ctx, calls } = context({ site, scenes: [] });
  const source = createTpdbWatchlistSource({ token: "token", studios: studio });
  await source.fetch("2026-10-01", ctx);
  await source.fetch("2026-10-01", ctx);
  assert.equal(siteCalls(calls).length, 1, "the site map is resolved once, not per poll");
  assert.equal(sceneCalls(calls).length, 2, "scene listings are still re-read on each refresh");
});
