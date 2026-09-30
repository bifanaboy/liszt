/**
 * The traxxx filter guard. This is the highest-consequence source failure the
 * plan names: an unknown entity slug is silently ignored upstream and returns
 * the whole ~500k index, so one typo would ingest everything as one studio.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertFilterApplies,
  entityFilter,
  parseTraxxxDate,
  parseTraxxxPoster,
  parseTraxxxScene,
  sceneMatchesEntity,
  type TraxxxClient,
} from "../src/sources/traxxx.ts";

const client = (filteredTotal: number, unfiltered: number): TraxxxClient => ({
  listScenes: async () => ({ scenes: [], total: filteredTotal, limit: 100 }),
  unfilteredTotal: async () => unfiltered,
  getScene: async () => null,
});

test("a silently-ignored entity filter throws instead of returning the index", async () => {
  await assert.rejects(
    () => assertFilterApplies(client(500_000, 500_000), "channel", "typo"),
    /matched nothing/,
  );
});

test("a filter that genuinely narrows the result is accepted", async () => {
  const page = await assertFilterApplies(client(120, 500_000), "channel", "tushy");
  assert.equal(page.total, 120);
});

test("channel and network slugs cannot collide", () => {
  assert.equal(entityFilter("channel", "tushy"), "tushy");
  assert.equal(entityFilter("network", "tushy"), "_tushy");
});

test("a foreign record is rejected by the per-record entity recheck", () => {
  const record = { id: 1, title: "x", channel: { slug: "mamboperv" } };
  assert.equal(sceneMatchesEntity(record, "channel", "tushy"), false);
  assert.equal(sceneMatchesEntity(record, "channel", "mamboperv"), true);
});

test("dates are reduced to the date part", () => {
  assert.equal(parseTraxxxDate("!Date:2026-03-04T10:00:00Z"), "2026-03-04");
  assert.equal(parseTraxxxDate("2026-03-04"), "2026-03-04");
  assert.equal(parseTraxxxDate("nonsense"), "");
});

test("posters are rebuilt against the traxxx CDN", () => {
  assert.equal(parseTraxxxPoster({ path: "/x/y.jpg" }), "https://cdn.traxxx.me/x/y.jpg");
  assert.equal(parseTraxxxPoster({ thumbnail: "https://abs/y.jpg" }), "https://abs/y.jpg");
  assert.equal(parseTraxxxPoster(null), "");
});

test("a scene missing its id or title throws rather than emitting a partial record", () => {
  assert.throws(() => parseTraxxxScene({ id: 1 } as never), /missing its ID or title/);
  assert.throws(() => parseTraxxxScene({ title: "x" } as never), /missing its ID or title/);
});

test("male actors are dropped and the performer list is deduplicated", () => {
  const scene = parseTraxxxScene({
    id: 42,
    title: "A title",
    date: "2026-03-04",
    duration: 1418.6,
    actors: [
      { name: "Marfe", gender: "female" },
      { name: "Marfe", gender: "female" },
      { name: "Someone", gender: "male" },
    ],
  });
  assert.deepEqual(scene.performers, ["Marfe"]);
  assert.equal(scene.durationSec, 1419);
  assert.equal(scene.provenance?.source, "traxxx.me");
});