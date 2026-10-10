import { test } from "node:test";
import assert from "node:assert/strict";
import { createTpdbWatchlistSource, cleanStudioName } from "../src/sources/tpdb-watchlist.ts";
import { FetchError } from "../src/core/fetcher.ts";
import type { SourceContext } from "../src/sources/types.ts";

const studio = [
  { studioId: "network-brazzers-anal", studio: "Brazzers", aliases: ["Brazzers"], siteIds: [7] },
];
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
const page = (data: unknown[], currentPage = 1, lastPage = 1) => ({
  data,
  meta: { current_page: currentPage, last_page: lastPage },
});

/**
 * Routes a request by URL so a test states only what it cares about.
 *
 * The `/sites` directory walk is GONE from this lane (it threw
 * "inconsistent pagination on page 1" against the live API), so no route
 * serves `/sites` and a test that expects one is asserting the old design.
 */
function context(
  routes: { scenes?: unknown[]; scenePages?: unknown[][] },
  opts: { now?: string; fail?: Error } = {},
) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const pages = routes.scenePages ?? (routes.scenes ? [routes.scenes] : undefined);
  const ctx = {
    now: new Date(opts.now ?? "2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string, options?: { headers?: Record<string, string> }) => {
        calls.push({ url, headers: options?.headers });
        if (opts.fail) throw opts.fail;
        const parsed = new URL(url);
        if (parsed.pathname === "/scenes") {
          if (!pages) throw new Error("unexpected scene request");
          // Paged listings are served by the requested page number, so a test can
          // assert that the walker reads page two and then stops at last_page.
          const requested = Number(parsed.searchParams.get("page") ?? "1");
          return page(pages[requested - 1] ?? [], requested, pages.length);
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

test("cleans names without collapsing different words", () => {
  assert.equal(cleanStudioName("  Bräzzers & Co. "), "brazzers co");
  assert.notEqual(cleanStudioName("Anal Quest"), cleanStudioName("Analquest"));
});

test("the lane never reads the TPDB site directory", async () => {
  // The `/sites` walk threw `inconsistent pagination on page 1` against the
  // live API. The lane now builds its site map from configured siteIds alone,
  // so a request to `/sites` is the regression this test exists to catch.
  const { ctx, calls } = context({ scenes: [scene] });
  const result = await createTpdbWatchlistSource({
    token: "private-token",
    studios: studio,
  }).fetch("2026-10-01", ctx);
  assert.equal(calls[0]?.headers?.Authorization, "Bearer private-token");
  assert.deepEqual(
    calls.map((call) => new URL(call.url).pathname),
    ["/scenes"],
    "no /sites directory request is ever made",
  );
  assert.match(sceneCalls(calls)[0]!.url, /site_id=7/);
  assert.equal(result.scenes[0]?.studioId, "network-brazzers-anal");
});

test("the studio name comes from TPDB's own site name on the scene, not the config label", async () => {
  // No directory walk means a numeric-only anal lane has no resolved name in
  // config. TPDB reports site.name on every scene row, and that is the current
  // display name.
  const { ctx, calls } = context({ scenes: [{ ...scene, site: { name: "Bangbros" } }] });
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [
      { studioId: "tpdb-4820~anal", studio: "TPDB site 4820", aliases: [], siteIds: [4820] },
    ],
  }).fetch("2026-10-01", ctx);
  assert.equal(sceneCalls(calls).length, 1);
  assert.equal(result.scenes[0]?.studio, "Bangbros");
  assert.equal(result.scenes[0]?.studioId, "tpdb-4820~anal");
});

test("a scene with no site object falls back to the configured studio name", async () => {
  const { site: _site, ...noSite } = scene;
  const { ctx } = context({ scenes: [noSite] });
  const result = await createTpdbWatchlistSource({ token: "token", studios: studio }).fetch(
    "2026-10-01",
    ctx,
  );
  assert.equal(result.scenes[0]?.studio, "Brazzers");
});

test("configured TPDB site IDs each get their own scene listing", async () => {
  const requested: string[] = [];
  const ids = [50864, 39697, 81939];
  const ctx = {
    now: new Date("2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string) => {
        requested.push(url);
        const parsed = new URL(url);
        if (parsed.pathname !== "/scenes") throw new Error(`unexpected request ${url}`);
        const id = parsed.searchParams.get("site_id");
        return {
          data: [
            { ...scene, id: `scene-${id}`, tags: [{ name: "Anal" }] },
            { ...scene, id: `excluded-${id}`, tags: [{ name: "Comedy" }] },
          ],
          meta: { current_page: 1, last_page: 1 },
        };
      },
    },
    log: () => {},
    mapWithConcurrency: async (items: unknown[], fn: (item: unknown) => unknown) =>
      Promise.all(items.map(fn)),
    mapIsolated: async (items: unknown[], fn: (item: unknown) => unknown) =>
      Promise.all(items.map(fn)),
  } as unknown as SourceContext;
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [
      {
        studioId: "dredd",
        studio: "Dredd",
        aliases: ["DreddXXX"],
        siteIds: ids,
        tags: ["Anal"],
      },
    ],
  }).fetch("2026-10-01", ctx);

  assert.equal(requested.filter((url) => new URL(url).pathname === "/scenes").length, 3);
  assert.deepEqual(
    result.scenes.map((record) => record.studioId),
    ["dredd", "dredd", "dredd"],
  );
  assert.equal(result.scenes.length, 3);
});

test("emits scenes for the configured studio with its record fields intact", async () => {
  const { ctx, calls } = context({ scenes: [scene] });
  const result = await createTpdbWatchlistSource({
    token: "private-token",
    studios: studio,
  }).fetch("2026-10-01", ctx);
  assert.equal(calls[0]?.headers?.Authorization, "Bearer private-token");
  const listing = sceneCalls(calls)[0]!.url;
  assert.match(listing, /site_id=7/);
  assert.equal(result.scenes[0]?.studioId, "network-brazzers-anal");
  assert.equal(result.scenes[0]?.durationSec, 600);
  assert.equal(result.scenes[0]?.releaseUrl, scene.url);
});

test("a studio with no configured site IDs contributes nothing and requests nothing", async () => {
  // Replaces the old alias-resolution tests. Alias matching against the site
  // directory is gone: a studio is only reachable through a declared siteId.
  const { ctx, calls } = context({ scenes: [scene] });
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [{ studioId: "lane-missing", studio: "Jules Jordan", aliases: ["Jules Jordan"] }],
  }).fetch("2026-10-01", ctx);
  assert.deepEqual(result, { scenes: [], verifiedEmpty: false });
  assert.equal(sceneCalls(calls).length, 0);
});

test("a studio with no site IDs does not stop the configured studio from contributing", async () => {
  const { ctx, calls } = context({ scenes: [scene] });
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [
      ...studio,
      { studioId: "lane-missing", studio: "Jules Jordan", aliases: ["Jules Jordan"], siteIds: [] },
    ],
  }).fetch("2026-10-01", ctx);
  assert.equal(result.scenes.length, 1, "the matched studio still contributes");
  assert.equal(sceneCalls(calls).length, 1, "only the configured studio is read");
});

test("missing token and temporary failures throw without returning records", async () => {
  const noToken = createTpdbWatchlistSource({ studios: studio });
  await assert.rejects(noToken.fetch("2026-10-01", context({}).ctx), /token missing/);
  const source = createTpdbWatchlistSource({ token: "secret", studios: studio });
  await assert.rejects(
    source.fetch(
      "2026-10-01",
      context({}, { fail: new FetchError("GET /scenes?site_id=7 -> 503", "inconclusive", 503) })
        .ctx,
    ),
    /503/,
    "a failing lookup propagates; it must not read as an absent studio",
  );
});

test("a matched studio with no in-window scenes reports a verified empty result", async () => {
  const result = await createTpdbWatchlistSource({ token: "token", studios: studio }).fetch(
    "2026-10-01",
    context({ scenes: [] }).ctx,
  );
  assert.deepEqual(result, { scenes: [], verifiedEmpty: true });
});

test("a studio with no configured site IDs is an unverified empty result", async () => {
  const { ctx, calls } = context({ scenes: [scene] });
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [
      { studioId: "lane-missing", studio: "Jules Jordan", aliases: ["Jules Jordan"], siteIds: [] },
    ],
  }).fetch("2026-10-01", ctx);
  assert.deepEqual(result, { scenes: [], verifiedEmpty: false });
  assert.equal(sceneCalls(calls).length, 0, "no site IDs means no scene listing is requested");
});

test("tagged lanes retain only TPDB scenes carrying every requested tag", async () => {
  const taggedScene = { ...scene, tags: [{ name: "Anal" }, { name: "Creampie" }] };
  const untaggedScene = { ...scene, id: "s2", tags: [{ name: "Anal" }] };
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [{ ...studio[0]!, tags: ["anal", "creampie"] }],
  }).fetch("2026-10-01", context({ scenes: [taggedScene, untaggedScene] }).ctx);
  assert.deepEqual(
    result.scenes.map((entry) => entry.sourceSceneId),
    ["s1"],
  );
});

test("a multi-page listing is walked to last_page and then stops", async () => {
  // Covers the pagination field this lane reads. The first page reports
  // last_page 2, so the walker must request page two and must not ask for a
  // third - an off-by-one here would either drop half the window or spin.
  const second = { ...scene, id: "s2", title: "Second page scene" };
  const { ctx, calls } = context({ scenePages: [[scene], [second]] });
  const result = await createTpdbWatchlistSource({ token: "token", studios: studio }).fetch(
    "2026-10-01",
    ctx,
  );
  assert.equal(sceneCalls(calls).length, 2, "page two is read, and no page three is requested");
  assert.deepEqual(
    result.scenes.map((entry) => entry.sourceSceneId),
    ["s1", "s2"],
  );
});

test("scene listings are re-read on every poll", async () => {
  const { ctx, calls } = context({ scenes: [] });
  const source = createTpdbWatchlistSource({ token: "token", studios: studio });
  await source.fetch("2026-10-01", ctx);
  await source.fetch("2026-10-01", ctx);
  assert.equal(sceneCalls(calls).length, 2, "scene listings are still re-read on each refresh");
});
