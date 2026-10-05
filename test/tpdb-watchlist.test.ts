import { test } from "node:test";
import assert from "node:assert/strict";
import { createTpdbWatchlistSource, cleanStudioName } from "../src/sources/tpdb-watchlist.ts";
import { FetchError } from "../src/core/fetcher.ts";
import type { SourceContext } from "../src/sources/types.ts";

const studio = [
  { studioId: "network-brazzers-anal", studio: "Brazzers", aliases: ["Brazzers"], siteIds: [] },
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
const site = { id: 7, name: "Brazzers", short_name: "brazzers" };
const page = (data: unknown[], currentPage = 1, lastPage = 1) => ({
  data,
  meta: { current_page: currentPage, last_page: lastPage },
});

/** Routes a request by URL so a test states only what it cares about. */
function context(
  routes: { site?: unknown; scenes?: unknown[]; lookupMisses?: string[]; scenePages?: unknown[][] },
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
        if (parsed.pathname === "/sites") {
          return page(routes.site ? [routes.site] : []);
        }
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
const siteCalls = (calls: Array<{ url: string }>) =>
  calls.filter((call) => new URL(call.url).pathname === "/sites");

test("cleans names without collapsing different words", () => {
  assert.equal(cleanStudioName("  Bräzzers & Co. "), "brazzers co");
  assert.notEqual(cleanStudioName("Anal Quest"), cleanStudioName("Analquest"));
});

test("a unique TPDB alias maps a site instead of marking its first claim ambiguous", async () => {
  const requests: string[] = [];
  const ctx = {
    now: new Date("2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string) => {
        requests.push(url);
        if (new URL(url).pathname === "/sites") {
          return {
            data: [{ id: 50864, name: "DreddXXX", short_name: "dreddxxx" }],
            meta: { current_page: 1, last_page: 1 },
          };
        }
        if (new URL(url).pathname === "/scenes") {
          return {
            data: [scene],
            meta: { current_page: 1, last_page: 1 },
          };
        }
        throw new Error(`unexpected URL ${url}`);
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
    studios: [{ studioId: "dredd", studio: "Dredd", aliases: ["DreddXXX"] }],
  }).fetch("2026-10-01", ctx);

  assert.match(requests[1] ?? "", /site_id=50864/);
  assert.equal(result.scenes[0]?.studioId, "dredd");
});

test("configured TPDB site IDs merge under one studio and apply the declared tag", async () => {
  const requested: string[] = [];
  const ids = [50864, 39697, 81939];
  const ctx = {
    now: new Date("2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string) => {
        requested.push(url);
        const parsed = new URL(url);
        if (parsed.pathname === "/sites") {
          return {
            data: ids.map((id) => ({ id, name: `Unlisted site ${id}` })),
            meta: { current_page: 1, last_page: 1 },
          };
        }
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

test("scans TPDB sites and emits scenes for the configured studio", async () => {
  const { ctx, calls } = context({ site, scenes: [scene] });
  const result = await createTpdbWatchlistSource({
    token: "private-token",
    studios: studio,
  }).fetch("2026-10-01", ctx);
  assert.equal(calls[0]?.headers?.Authorization, "Bearer private-token");
  assert.equal(new URL(calls[0]!.url).pathname, "/sites");
  assert.equal(siteCalls(calls).length, 1, "the TPDB site catalogue is read once per poll");
  const listing = sceneCalls(calls)[0]!.url;
  assert.match(listing, /site_id=7/);
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
    studios: [
      { studioId: "lane", studio: "Elegant Angel", aliases: ["Elegant Angel"], siteIds: [] },
    ],
  }).fetch("2026-10-01", ctx);
  assert.equal(new URL(calls[0]!.url).pathname, "/sites");
  assert.match(sceneCalls(calls)[0]!.url, /site_id=1052/);
});

test("a differently-named site is not assigned to a configured studio", async () => {
  const { ctx } = context({
    site: { id: 999, name: "Someone Else Entirely", short_name: "someoneelse" },
    scenes: [scene],
  });
  const result = await createTpdbWatchlistSource({ token: "token", studios: studio }).fetch(
    "2026-10-01",
    ctx,
  );
  assert.deepEqual(result, { scenes: [], verifiedEmpty: false });
});

test("a studio TPDB does not carry is reported unmatched, and the rest still run", async () => {
  const { ctx, calls } = context({ site, scenes: [scene], lookupMisses: ["jules jordan"] });
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [
      ...studio,
      { studioId: "lane-missing", studio: "Jules Jordan", aliases: ["Jules Jordan"], siteIds: [] },
    ],
  }).fetch("2026-10-01", ctx);
  assert.equal(result.scenes.length, 1, "the matched studio still contributes");
  assert.equal(siteCalls(calls).length, 1, "all studios are compared against one site catalogue");
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

test("no matching site name is an unverified empty result", async () => {
  const result = await createTpdbWatchlistSource({ token: "token", studios: studio }).fetch(
    "2026-10-01",
    context({ scenes: [scene] }).ctx,
  );
  assert.deepEqual(result, { scenes: [], verifiedEmpty: false });
});

test("ambiguous TPDB studio names are excluded", async () => {
  const { ctx, calls } = context({ site, scenes: [scene] });
  const source = createTpdbWatchlistSource({
    token: "token",
    studios: [
      { studioId: "lane-a", studio: "Shared Studio", aliases: ["Shared Studio"], siteIds: [] },
      { studioId: "lane-b", studio: "Shared Studio", aliases: ["Shared Studio"], siteIds: [] },
    ],
  });
  const result = await source.fetch("2026-10-01", ctx);
  assert.equal(result.verifiedEmpty, false);
  assert.equal(sceneCalls(calls).length, 0, "ambiguous matches fetch no scene listings");
});

test("three-way aliases stay ambiguous and an ambiguous full name cannot fall back to short name", async () => {
  const { ctx, calls } = context({ site, scenes: [scene] });
  const source = createTpdbWatchlistSource({
    token: "token",
    studios: [
      { studioId: "lane-a", studio: "A", aliases: ["Shared Studio", "lane-a"], siteIds: [] },
      { studioId: "lane-b", studio: "B", aliases: ["Shared Studio"], siteIds: [] },
      { studioId: "lane-c", studio: "C", aliases: ["Shared Studio"], siteIds: [] },
    ],
  });
  const result = await source.fetch("2026-10-01", ctx);
  assert.equal(result.verifiedEmpty, false);
  assert.equal(sceneCalls(calls).length, 0);
});

test("tagged lanes retain only TPDB scenes carrying every requested tag", async () => {
  const taggedScene = { ...scene, tags: [{ name: "Anal" }, { name: "Creampie" }] };
  const untaggedScene = { ...scene, id: "s2", tags: [{ name: "Anal" }] };
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [{ ...studio[0]!, tags: ["anal", "creampie"], siteIds: [] }],
  }).fetch("2026-10-01", context({ site, scenes: [taggedScene, untaggedScene] }).ctx);
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
  const { ctx, calls } = context({ site, scenePages: [[scene], [second]] });
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

test("an unrecognised short name is an abbreviation, not a collision", async () => {
  // TPDB short names are frequently an abbreviation of the display name
  // ("elegantangel" for "Elegant Angel"). Treating an unknown short name as a
  // disagreement would reject real studios; only a name owned by a DIFFERENT
  // configured studio is a collision.
  const { ctx, calls } = context({
    site: { id: 1052, name: "Elegant Angel", short_name: "elegantangel" },
    scenes: [scene],
  });
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [
      { studioId: "lane", studio: "Elegant Angel", aliases: ["Elegant Angel"], siteIds: [] },
    ],
  }).fetch("2026-10-01", ctx);
  assert.equal(result.scenes.length, 1);
  assert.match(sceneCalls(calls)[0]!.url, /site_id=1052/);
});

test("a site whose short name belongs to another studio is rejected, not accepted", async () => {
  // The name and the short name are separate evidence. If they disagree about
  // which studio this is, that is a collision - accepting on the strength of
  // one name would file another studio's releases under this lane.
  const { ctx, calls } = context({
    site: { id: 555, name: "Brazzers", short_name: "someotherstudio" },
    scenes: [scene],
  });
  const result = await createTpdbWatchlistSource({
    token: "token",
    studios: [
      ...studio,
      {
        studioId: "lane-other",
        studio: "Someotherstudio",
        aliases: ["Someotherstudio"],
        siteIds: [],
      },
    ],
  }).fetch("2026-10-01", ctx);
  assert.equal(result.verifiedEmpty, false);
  assert.equal(sceneCalls(calls).length, 0, "no scene listing is fetched for a rejected site");
});

test("a failed site catalogue fetch propagates so sync can retain last-good records", async () => {
  const source = createTpdbWatchlistSource({ token: "token", studios: studio });
  await assert.rejects(
    source.fetch(
      "2026-10-01",
      context({}, { fail: new FetchError("GET /sites -> 503", "inconclusive", 503) }).ctx,
    ),
    /503/,
  );
});

test("refreshes the matched site map on every poll", async () => {
  const { ctx, calls } = context({ site, scenes: [] });
  const source = createTpdbWatchlistSource({ token: "token", studios: studio });
  await source.fetch("2026-10-01", ctx);
  await source.fetch("2026-10-01", ctx);
  assert.equal(siteCalls(calls).length, 2, "stale studio names are not reused between polls");
  assert.equal(sceneCalls(calls).length, 2, "scene listings are still re-read on each refresh");
});
