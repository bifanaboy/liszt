import { test } from "node:test";
import assert from "node:assert/strict";
import { createSources } from "../src/sources/registry.ts";
import { loadConfig } from "../src/config.ts";
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
  assert.equal(result.scenes.length, 4);
  assert.deepEqual(
    result.scenes.map((scene) => scene.studioId),
    ["tpdb-maximogarcia", "tpdb-maximogarcia", "tpdb-maximogarcia", "tpdb-maximogarcia"],
  );
});
