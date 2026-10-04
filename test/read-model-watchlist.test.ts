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

test("fallback matching requires one candidate and preserves title word boundaries", () => {
  const prior = record({ durationSec: 600 });
  const same = record({ id: "another", durationSec: 600 });
  const incoming = record({
    id: "tpdb",
    sourceId: "tpdb-watchlist",
    source: "TPDB",
    durationSec: 600,
  });
  assert.equal(mergeWatchlistDuplicates([prior, same, incoming]).length, 3);
  assert.equal(
    mergeWatchlistDuplicates([
      record({ title: "Anal Quest", durationSec: 600 }),
      record({
        id: "tpdb",
        sourceId: "tpdb-watchlist",
        source: "TPDB",
        title: "Analquest",
        durationSec: 600,
      }),
    ]).length,
    2,
  );
});

test("does not absorb a second record from an already merged provider", () => {
  const first = record({ durationSec: 600 });
  const tpdb = record({
    id: "tpdb-1",
    sourceId: "tpdb-watchlist",
    source: "TPDB",
    durationSec: 600,
  });
  const secondTpdb = { ...tpdb, id: "tpdb-2" };
  assert.equal(mergeWatchlistDuplicates([first, tpdb, secondTpdb]).length, 2);
});

test("keeps the canonical playback verdict and filters contradictory dead links", () => {
  const liveUrl = "https://tube.test/live";
  const prior = record({
    releaseUrl: "https://studio.test/release",
    videoUrls: [
      { source: "eporner", url: liveUrl, verifiedAt: "2026-10-04T00:00:00Z", verifyFailures: 0 },
    ],
    videoMatching: {
      lane: "eporner-pool",
      matchedAt: "2026-10-04T00:00:00Z",
      rule: "named",
      confidence: "high",
    },
  });
  const incoming = record({
    id: "tpdb",
    sourceId: "tpdb-watchlist",
    source: "TPDB",
    releaseUrl: "https://studio.test/release",
    thumbnailUrl: "https://img.test/poster.jpg",
    fieldProvenance: { thumbnailUrl: "TPDB" },
    videoUrls: [
      {
        source: "sxyprn",
        url: "https://tube.test/other",
        verifiedAt: "2026-10-04T00:00:00Z",
        verifyFailures: 0,
      },
    ],
    deadVideoUrls: [
      { source: "eporner", url: liveUrl, deadAt: "2026-10-04T00:00:00Z", deadReason: "gone" },
    ],
    videoMatching: {
      lane: "fallback",
      matchedAt: "2026-10-04T00:00:00Z",
      rule: "guess",
      confidence: "low",
    },
  });
  const merged = mergeWatchlistDuplicates([prior, incoming])[0]!;
  assert.deepEqual(merged.videoUrls, []);
  assert.equal(merged.videoMatching, null);
  assert.equal(merged.fieldProvenance.thumbnailUrl, "TPDB");
  assert.deepEqual((merged as Scene & { contributingSourceIds: string[] }).contributingSourceIds, [
    "manyvids-1",
    "tpdb-watchlist",
  ]);
});
