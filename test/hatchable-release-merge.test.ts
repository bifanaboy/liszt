import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRelease } from "../lib/release-merge.js";
import type { ProviderObservation } from "../src/sources/types.ts";

const observation = (
  providerId: string,
  recordId: string,
  record: ProviderObservation["record"],
): ProviderObservation => ({
  providerId,
  recordId,
  sceneId: "release",
  studioId: record.studioId ?? "studio",
  studio: record.studio ?? "Studio",
  record,
  fetchedAt: "2026-10-04T00:00:00.000Z",
});

test("merges provider observations and keeps selected field provenance", () => {
  const merged = mergeRelease(
    [
      observation("provider-b", "b1", {
        sourceSceneId: "b1",
        title: "Shared release",
        releaseDate: "2026-10-02",
        performers: ["Alex"],
        durationSec: 600,
        thumbnailUrl: "https://b.test/poster.jpg",
        releaseUrl: "https://studio.test/scene/1",
      }),
      observation("provider-a", "a1", {
        sourceSceneId: "a1",
        title: "Shared release",
        releaseDate: "2026-10-02",
        performers: ["Alex"],
        durationSec: 600,
        thumbnailUrl: "",
        releaseUrl: "https://studio.test/scene/1",
      }),
    ],
    { priority: { title: ["provider-a", "provider-b"], thumbnailUrl: ["provider-b"] } },
  );

  assert.equal(merged.title, "Shared release");
  assert.equal(merged.thumbnailUrl, "https://b.test/poster.jpg");
  assert.equal(merged.fieldProvenance?.title, "provider-a");
  assert.equal(merged.fieldProvenance?.thumbnailUrl, "provider-b");
  assert.deepEqual(merged.provenance?.source, "provider-a");
});

test("uses configured priority for conflicting fields and is order independent", () => {
  const records = [
    observation("provider-b", "b1", {
      sourceSceneId: "b1",
      title: "Later source title",
      releaseDate: "2026-10-03",
      performers: ["B"],
      durationSec: 602,
      thumbnailUrl: "",
    }),
    observation("provider-a", "a1", {
      sourceSceneId: "a1",
      title: "Preferred title",
      releaseDate: "2026-10-02",
      performers: ["A"],
      durationSec: 600,
      thumbnailUrl: "",
    }),
  ];
  const policy = { priority: { title: ["provider-a"], releaseDate: ["provider-b"] } };

  assert.equal(mergeRelease(records, policy).title, "Preferred title");
  assert.equal(mergeRelease(records, policy).releaseDate, "2026-10-03");
  assert.equal(mergeRelease(records.reverse(), policy).title, "Preferred title");
});

test("missing fields retain the last good provider value", () => {
  const prior = observation("provider-a", "a1", {
    sourceSceneId: "a1",
    title: "Kept title",
    releaseDate: "2026-10-02",
    performers: ["Alex"],
    durationSec: 600,
    thumbnailUrl: "https://a.test/poster.jpg",
  });
  const next = observation("provider-b", "b1", {
    sourceSceneId: "b1",
    title: "Updated title",
    releaseDate: "2026-10-02",
    performers: [],
    durationSec: null,
    thumbnailUrl: "",
  });

  const merged = mergeRelease([next, prior]);
  assert.deepEqual(merged.performers, ["Alex"]);
  assert.equal(merged.durationSec, 600);
  assert.equal(merged.thumbnailUrl, "https://a.test/poster.jpg");
});

test("duration disagreement becomes a provenance-backed range and wide ranges need review", () => {
  const records = [
    observation("provider-a", "a1", {
      sourceSceneId: "a1",
      title: "Shared release",
      releaseDate: "2026-10-02",
      performers: [],
      durationSec: 600,
      thumbnailUrl: "",
    }),
    observation("provider-b", "b1", {
      sourceSceneId: "b1",
      title: "Shared release",
      releaseDate: "2026-10-02",
      performers: [],
      durationSec: 602,
      thumbnailUrl: "",
    }),
  ];
  const merged = mergeRelease(records);
  assert.equal(merged.durationSec, null);
  assert.deepEqual(merged.durationRange, { minSec: 600, maxSec: 602 });
  assert.equal(merged.durationReview, true);
  assert.equal(merged.fieldProvenance?.durationSec, "provider-a, provider-b");
});

test("Maximo equal-duration duplicates select the oldest release date", () => {
  const records = [
    observation("provider-b", "b1", {
      sourceSceneId: "b1",
      title: "Shared release",
      releaseDate: "2026-10-03",
      performers: [],
      durationSec: 600,
      thumbnailUrl: "",
      studioId: "maximo-garcia",
    }),
    observation("provider-a", "a1", {
      sourceSceneId: "a1",
      title: "Shared release",
      releaseDate: "2026-10-01",
      performers: [],
      durationSec: 600,
      thumbnailUrl: "",
      studioId: "maximo-garcia",
    }),
  ];
  assert.equal(mergeRelease(records, { oldestDate: true }).releaseDate, "2026-10-01");
});
