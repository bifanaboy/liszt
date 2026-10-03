import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASIAN_CATALOGUE,
  MAIN_CATALOGUE,
  catalogueId,
  catalogueScenes,
  catalogueStats,
  inCatalogue,
  isAsian,
} from "../public/catalogues.js";
import { buildReadModel } from "../src/serving/read-model.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import type { Config } from "../src/config.ts";

const ASIAN = ["fc2cmadb", "madouqu"];

const scenes = [
  {
    sourceId: "lancelot-styles-evolution",
    labelId: "lancelot-styles-evolution",
    title: "A western release",
    videoUrls: [{ url: "https://tube.test/1" }],
  },
  // A Madouqu sub-label: same source, so it belongs on the Asian page.
  { sourceId: "madouqu", labelId: "madouqu-peach", title: "桃", videoUrls: [] },
  { sourceId: "fc2cmadb", labelId: "fc2cmadb", title: "FC2 release", videoUrls: [] },
];

test("a nav id or hash fragment resolves to a catalogue, and Sources to neither", () => {
  assert.equal(catalogueId("asian"), ASIAN_CATALOGUE);
  assert.equal(catalogueId("#Asian"), ASIAN_CATALOGUE);
  assert.equal(catalogueId("#catalogue"), MAIN_CATALOGUE);
  assert.equal(catalogueId("#sources"), null);
  assert.equal(catalogueId(undefined), null);
});

test("Asian membership follows the source, so every sub-label goes to that page", () => {
  assert.equal(isAsian(scenes[0], ASIAN), false);
  assert.equal(isAsian(scenes[1], ASIAN), true);
  // An unconfigured read model carries no ids: nothing is misfiled as Asian.
  assert.equal(isAsian(scenes[1], []), false);
  assert.equal(inCatalogue(scenes[0], ASIAN_CATALOGUE, ASIAN), false);
  assert.equal(inCatalogue(scenes[1], MAIN_CATALOGUE, ASIAN), false);
});

test("the two pages partition the window with no scene in both and none missing", () => {
  const main = catalogueScenes(scenes, MAIN_CATALOGUE, ASIAN);
  const asian = catalogueScenes(scenes, ASIAN_CATALOGUE, ASIAN);
  assert.deepEqual(
    main.map((scene) => scene.title),
    ["A western release"],
  );
  assert.deepEqual(
    asian.map((scene) => scene.title),
    ["桃", "FC2 release"],
  );
  assert.equal(main.length + asian.length, scenes.length);
});

test("each page's linking percentage counts only the rows that page shows", () => {
  // The whole window is 1 of 3 linked; neither page may quote that figure.
  assert.deepEqual(catalogueStats(scenes, MAIN_CATALOGUE, ASIAN), {
    total: 1,
    live: 1,
    matchPercent: 100,
  });
  assert.deepEqual(catalogueStats(scenes, ASIAN_CATALOGUE, ASIAN), {
    total: 2,
    live: 0,
    matchPercent: 0,
  });
  // Nothing to divide by: null rather than a fabricated 0%.
  assert.equal(catalogueStats([], ASIAN_CATALOGUE, ASIAN).matchPercent, null);
});

test("the read model names the Asian lanes so the UI never hard-codes them", () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const model = buildReadModel(
    store,
    { windowDays: 90 } as Config,
    new Date("2026-03-10T00:00:00Z"),
  );
  assert.deepEqual(model.asianSourceIds, ["fc2cmadb", "madouqu"]);
  store.close();
});
