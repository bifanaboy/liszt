import { test } from "node:test";
import assert from "node:assert/strict";
import { DateOnly, IsoTimestamp, parseAtBoundary, Scene } from "../lib/schema.js";

test("Hatchable schema keeps real date and timestamp validation", () => {
  assert.equal(DateOnly.safeParse("2024-02-29").success, true);
  assert.equal(DateOnly.safeParse("2023-02-29").success, false);
  assert.equal(DateOnly.safeParse("2026-03-04T10:00:00Z").success, false);
  assert.equal(IsoTimestamp.safeParse("2026-02-31T10:00:00Z").success, false);
});

test("the scene boundary applies defaults and reports malformed records", () => {
  const scene = parseAtBoundary(
    Scene,
    {
      id: "feed:1",
      sourceId: "feed",
      source: "Example",
      labelId: "feed",
      title: "Release",
      releaseDate: "2026-10-08",
      provenance: [{ source: "Example", fetchedAt: "2026-10-08T12:00:00Z" }],
    },
    "test",
  );
  assert.deepEqual(scene.performers, []);
  assert.deepEqual(scene.videoUrls, []);
  assert.throws(() => parseAtBoundary(Scene, { ...scene, provenance: [] }, "test"), /provenance/);
});
