import { test } from "node:test";
import assert from "node:assert/strict";
import { createSources } from "../src/sources/registry.ts";
import { loadConfigForTest as loadConfig } from "./test-config.ts";
import type { SourceContext } from "../src/sources/types.ts";

test("the TPDB source is omitted when no key is configured", () => {
  const sources = createSources({
    madouquApiBase: "https://example.test/wp-json",
    traxxxWatchlist: [],
  });
  assert.equal(
    sources.some((source) => source.id === "tpdb-watchlist"),
    false,
  );
});

test("default Dredd site IDs emit under the Dredd alias", async () => {
  const config = loadConfig({ TPDB_API_KEY: "test-token" });
  const sources = createSources({
    madouquApiBase: config.madouquApiBase,
    traxxxWatchlist: [],
    tpdbApiKey: config.tpdbApiKey,
    studioLinks: config.studioLinks,
  });
  const context = {
    now: new Date("2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/sites") {
          return {
            data: [50864, 39697, 81939].map((id) => ({ id, name: `TPDB name ${id}` })),
            meta: { current_page: 1, last_page: 1 },
          };
        }
        const id = parsed.searchParams.get("site_id");
        return {
          data: [
            {
              id: `scene-${id}`,
              title: `Scene ${id}`,
              date: "2026-10-03",
              duration: 600,
              url: `https://example.test/${id}`,
              performers: [],
              tags: [],
            },
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
  const tpdb = sources.find((source) => source.id === "tpdb-watchlist");
  assert.ok(tpdb);
  const result = await tpdb.fetch("2026-10-01", context);

  assert.equal(result.scenes.length, 3);
  assert.deepEqual(
    result.scenes.map((scene) => scene.studioId),
    ["dredd", "dredd", "dredd"],
  );
  assert.deepEqual(
    result.scenes.map((scene) => scene.studio),
    ["Dredd", "Dredd", "Dredd"],
  );
});

test("Maximo TPDB aliases and provider lanes share one canonical studio key", async () => {
  const config = loadConfig({ TPDB_API_KEY: "test-token" });
  const declaration = config.studioLinks.find((link) => link.studio === "Maximo Garcia");
  assert.equal(declaration?.studioId, "tpdb-maximogarcia");
  assert.deepEqual(declaration?.aliases, [
    "maximogarcia",
    "fuckingpornstars",
    "manyvidsmaximogarcia",
  ]);
  const sources = createSources({
    madouquApiBase: config.madouquApiBase,
    traxxxWatchlist: [],
    tpdbApiKey: config.tpdbApiKey,
    studioLinks: config.studioLinks,
  });
  assert.equal(sources.find((source) => source.id === "maximo-garcia")?.id, "maximo-garcia");
  assert.equal(
    sources.find((source) => source.id === "manyvids-1003095958")?.id,
    "manyvids-1003095958",
  );
  const context = {
    now: new Date("2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string) => {
        const parsed = new URL(url);
        if (parsed.pathname === "/sites") {
          return {
            data: [
              { id: 7875, name: "Maximo Garcia", short_name: "maximogarcia" },
              { id: 7876, name: "Fucking Pornstars", short_name: "fuckingpornstars" },
              { id: 7877, name: "ManyVids Maximo Garcia", short_name: "manyvidsmaximogarcia" },
              { id: 7878, name: "Maximo Garcia", short_name: "maximogarcia" },
            ],
            meta: { current_page: 1, last_page: 1 },
          };
        }
        return {
          data: [
            {
              id: `scene-${parsed.searchParams.get("site_id")}`,
              title: "A Maximo release",
              date: "2026-10-03",
              duration: 600,
              url: `https://example.test/${parsed.searchParams.get("site_id")}`,
              performers: [],
              tags: parsed.searchParams.get("site_id") === "7875" ? [{ name: "Anal" }] : [],
            },
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
  const tpdb = sources.find((source) => source.id === "tpdb-watchlist");
  assert.ok(tpdb);
  const result = await tpdb.fetch("2026-10-01", context);
  // No /sites directory walk, so the second "Maximo Garcia" (site 7878) is
  // never matched by alias. Only the DECLARED siteIds are read, and each
  // scene carries the studio declared for that id.
  assert.equal(result.scenes.length, 4);
  assert.deepEqual(
    result.scenes.map((scene) => scene.studioId),
    ["dredd", "dredd", "dredd", "tpdb-maximogarcia"],
  );
});

for (const tags of [undefined, [], ["creampie"], ["anal"]]) {
  test(`linked TPDB sites add anal only for listed IDs with original tags ${JSON.stringify(tags)}`, async () => {
    const siteIds = [7875, 7876];
    const sources = createSources({
      madouquApiBase: "https://example.test/wp-json",
      traxxxWatchlist: [],
      manyvidsStoreIds: [],
      tpdbApiKey: "test-token",
      studioLinks: [
        {
          studioId: "linked-studio",
          studio: "Linked Studio",
          aliases: ["Linked Alias"],
          tags,
          tpdb: { siteIds, name: "Linked TPDB Name" },
        },
      ],
    });
    const requestedSiteIds: number[] = [];
    const context = {
      now: new Date("2026-10-04T00:00:00Z"),
      fetcher: {
        json: async (url: string) => {
          const parsed = new URL(url);
          const meta = { current_page: 1, last_page: 1 };
          if (parsed.pathname === "/sites") {
            return {
              data: [
                ...siteIds.map((id) => ({ id, name: `TPDB site ${id}` })),
                { id: 7877, name: "Linked Alias" },
              ],
              meta,
            };
          }
          assert.equal(parsed.pathname, "/scenes");
          const siteId = Number(parsed.searchParams.get("site_id"));
          requestedSiteIds.push(siteId);
          return {
            data: [
              { suffix: "both", tags: ["Anal", "Creampie"] },
              { suffix: "creampie", tags: ["Creampie"] },
              { suffix: "anal", tags: ["Anal"] },
              { suffix: "neither", tags: [] },
            ].map((scene) => ({
              id: `${siteId}-${scene.suffix}`,
              title: `Scene ${siteId} ${scene.suffix}`,
              date: "2026-10-03",
              tags: scene.tags.map((name) => ({ name })),
            })),
            meta,
          };
        },
      },
      log: () => {},
    } as unknown as SourceContext;
    const tpdb = sources.find((source) => source.id === "tpdb-watchlist");
    assert.ok(tpdb);
    const result = await tpdb.fetch("2026-10-01", context);
    const listedSuffixes = tags?.includes("creampie") ? ["both"] : ["both", "anal"];
    const otherSuffixes = tags?.includes("creampie")
      ? ["both", "creampie"]
      : tags?.includes("anal")
        ? ["both", "anal"]
        : ["both", "creampie", "anal", "neither"];
    // Site 7877 was previously matched by ALIAS through the /sites directory.
    // That walk is gone. Assert the two facts that matter: the alias-matched
    // site is never read, and both DECLARED ids are.
    assert.ok(!requestedSiteIds.includes(7877), "the alias-matched site is no longer read");
    assert.ok(requestedSiteIds.includes(7875), "declared site 7875 is still read");
    assert.ok(requestedSiteIds.includes(7876), "declared site 7876 is still read");
    // Only THIS studio's scenes are asserted: the registry also registers its
    // 34 anal lanes, which contribute their own scenes to the same result.
    // The two site listings are fetched concurrently, so sort before comparing.
    const linkedScenes = result.scenes.filter((scene) => scene.studioId === "linked-studio");
    assert.deepEqual(
      linkedScenes.map((scene) => scene.sourceSceneId).sort(),
      [
        ...listedSuffixes.map((suffix) => `7875-${suffix}`),
        ...otherSuffixes.map((suffix) => `7876-${suffix}`),
      ].sort(),
    );
    assert.ok(
      linkedScenes.every(
        (scene) => scene.studioId === "linked-studio" && scene.studio === "Linked Studio",
      ),
    );
    assert.ok(linkedScenes.length > 0, "the linked studio actually contributed");
    assert.deepEqual(siteIds, [7875, 7876]);
  });
}
