import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeWatchlistDuplicates } from "../src/serving/read-model.ts";
import type { Scene } from "../src/core/schema.ts";

function record(overrides: Record<string, unknown> = {}): Scene {
  return {
    id: "manyvids-1:1",
    sourceId: "manyvids-1",
    source: "ManyVids",
    labelId: "network-brazzers-anal",
    label: "Brazzers",
    title: "Scene title",
    performers: [],
    releaseDate: "2026-10-03",
    durationSec: null,
    thumbnailUrl: "",
    tags: [],
    provenance: [{ source: "ManyVids", fetchedAt: "2026-10-04T00:00:00Z" }],
    fieldProvenance: {},
    metadataPoor: false,
    studioMetadataCheckedAt: null,
    videoUrls: [],
    deadVideoUrls: [],
    videoCheckedAt: null,
    videoMatching: null,
    ...overrides,
  } as Scene;
}

test("combines records by release URL and fills missing fields from TPDB", () => {
  const manyvids = record({ releaseUrl: "https://studio.test/scenes/1", sourceSceneId: "1" });
  const tpdb = record({
    id: "tpdb-watchlist:network-brazzers-anal:uuid",
    sourceId: "tpdb-watchlist",
    source: "TPDB",
    durationSec: 600,
    thumbnailUrl: "https://img.test/scene.jpg",
    performers: ["Alex"],
    releaseUrl: "https://studio.test/scenes/1/",
    provenance: [{ source: "TPDB", fetchedAt: "2026-10-04T00:00:00Z" }],
    fieldProvenance: { durationSec: "TPDB", performers: "TPDB" },
  });
  const merged = mergeWatchlistDuplicates([manyvids, tpdb]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, manyvids.id);
  assert.equal(merged[0]?.durationSec, 600);
  assert.deepEqual(merged[0]?.performers, ["Alex"]);
  assert.equal(merged[0]?.provenance.length, 2);
});

test("uses exact title, release date and duration only when either release URL is missing", () => {
  const first = record({ durationSec: 600 });
  const second = record({
    id: "tpdb",
    sourceId: "tpdb-watchlist",
    source: "TPDB",
    durationSec: 600,
  });
  assert.equal(mergeWatchlistDuplicates([first, second]).length, 1);
  assert.equal(
    mergeWatchlistDuplicates([
      record({ releaseUrl: "https://first.test/scene", durationSec: 600 }),
      record({
        id: "other",
        sourceId: "tpdb-watchlist",
        source: "TPDB",
        releaseUrl: "https://different.test/scene",
        durationSec: 600,
      }),
    ]).length,
    2,
  );
});
