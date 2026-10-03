/**
 * The traxxx filter guard. This is the highest-consequence source failure the
 * plan names: an unknown entity slug is silently ignored upstream and returns
 * the whole ~500k index, so one typo would ingest everything as one studio.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertFilterApplies,
  createTraxxxClient,
  createTraxxxStudio,
  entityFilter,
  parseRoster,
  parseTraxxxDate,
  parseTraxxxPoster,
  parseTraxxxScene,
  recordChannel,
  sceneMatchesEntity,
  type TraxxxClient,
} from "../src/sources/traxxx.ts";

const client = (filteredTotal: number, unfiltered: number): TraxxxClient => ({
  listScenes: async () => ({ scenes: [], total: filteredTotal, limit: 100, roster: [] }),
  entityTotal: async () => filteredTotal,
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

test("tag requests are sent and entity totals omit the tags", async () => {
  const urls: string[] = [];
  const api = createTraxxxClient(
    {
      fetcher: {
        fetch: async (url) => {
          urls.push(url);
          return Response.json({ scenes: [], total: 12, limit: 100 });
        },
        text: async () => "",
        json: async <T = unknown>() => ({}) as T,
      },
    },
    { minIntervalMs: 0 },
  );
  await api.listScenes("network", "vixen", 1, 100, { tags: ["anal", "bbc"] });
  await api.entityTotal("network", "vixen");
  assert.equal(new URL(urls[0]!).searchParams.get("tags"), "anal,bbc");
  assert.equal(new URL(urls[1]!).searchParams.has("tags"), false);
  assert.equal(new URL(urls[1]!).searchParams.get("e"), "_vixen");
});

test("a silently ignored tag filter throws against the entity total", async () => {
  const tagged: TraxxxClient = {
    ...client(120, 500_000),
    entityTotal: async () => 120,
  };
  await assert.rejects(
    () => assertFilterApplies(tagged, "network", "vixen", 100, ["not-a-real-tag"]),
    /tag filter/,
  );
});

test("roster parsing ignores entries without slugs", () => {
  assert.deepEqual(
    parseRoster({
      aggChannels: [
        { slug: "tushy", name: "Tushy", count: 7 },
        { slug: null, name: "Broken", count: 99 },
        { slug: "", name: "Blank", count: 2 },
      ],
    }),
    [{ slug: "tushy", name: "Tushy", count: 7 }],
  );
});

test("network records use their channel and null channels fall back to the lane", () => {
  assert.deepEqual(recordChannel({ channel: { slug: "tushy", name: "Tushy" } }, "vixen", "Vixen"), {
    slug: "tushy",
    name: "Tushy",
  });
  assert.deepEqual(recordChannel({ channel: null }, "vixen", "Vixen"), {
    slug: "vixen",
    name: "Vixen",
  });
  const network = parseTraxxxScene(
    {
      id: 123,
      title: "Network scene",
      date: "2026-03-04",
      channel: { slug: "tushy", name: "Tushy" },
    },
    { kind: "network", laneSlug: "vixen", laneName: "Vixen" },
  );
  assert.equal(network.studioId, "tushy");
  assert.equal(network.studio, "Tushy");
  const channel = parseTraxxxScene(
    {
      id: 123,
      title: "Channel scene",
      date: "2026-03-04",
      channel: { slug: "tushy", name: "Tushy" },
    },
    { kind: "channel", laneSlug: "tushy", laneName: "Tushy" },
  );
  assert.equal(channel.studioId, undefined);
});

test("a tagged network emits roster labels and stops when a full page crosses the window", async () => {
  const urls: string[] = [];
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const adapter = createTraxxxStudio({
    id: "vixen-anal",
    name: "Vixen",
    kind: "network",
    slug: "vixen",
    tags: ["anal"],
  });
  const fetcher = {
    fetch: async (url: string) => {
      urls.push(url);
      const parsed = new URL(url);
      if (!parsed.searchParams.has("tags")) {
        return Response.json({ scenes: [], total: 4048, limit: 1 });
      }
      return Response.json({
        total: 1341,
        limit: 2,
        aggChannels: [
          { slug: "tushy", name: "Tushy", count: 685 },
          { slug: "tushyraw", name: "Tushy Raw", count: 396 },
          { slug: "deeper", name: "Deeper", count: 93 },
          { slug: "blacked", name: "Blacked", count: 66 },
          { slug: "blackedraw", name: "Blacked Raw", count: 46 },
          { slug: "milfy", name: "Milfy", count: 41 },
          { slug: "vixen", name: "Vixen", count: 11 },
          { slug: "wifey", name: "Wifey", count: 3 },
        ],
        scenes: [
          {
            id: 1,
            title: "Recent",
            date: "2026-03-04",
            network: { slug: "vixen" },
            channel: { slug: "tushy", name: "Tushy" },
          },
          {
            id: 2,
            title: "Old",
            date: "2025-12-01",
            network: { slug: "vixen" },
            channel: null,
          },
        ],
      });
    },
    text: async () => "",
    json: async <T = unknown>() => ({}) as T,
  };
  const result = await adapter.fetch("2026-01-01", {
    fetcher,
    now: new Date("2026-03-05T00:00:00Z"),
    log(message, fields = {}) {
      logs.push({ message, fields });
    },
    traxxx: { minIntervalMs: 0 },
    mapWithConcurrency: async (items, task) => Promise.all(items.map(task)),
    mapIsolated: async (items, task) => Promise.all(items.map(task)),
  });
  assert.deepEqual(result.labels, [
    { labelId: "tushy", label: "Tushy", sceneCount: 685 },
    { labelId: "tushyraw", label: "Tushy Raw", sceneCount: 396 },
    { labelId: "deeper", label: "Deeper", sceneCount: 93 },
    { labelId: "blacked", label: "Blacked", sceneCount: 66 },
    { labelId: "blackedraw", label: "Blacked Raw", sceneCount: 46 },
    { labelId: "milfy", label: "Milfy", sceneCount: 41 },
    { labelId: "vixen", label: "Vixen", sceneCount: 11 },
    { labelId: "wifey", label: "Wifey", sceneCount: 3 },
  ]);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.scenes[0]?.studioId, "tushy");
  assert.equal(urls.filter((url) => new URL(url).searchParams.has("tags")).length, 1);
  assert.deepEqual(logs.find((entry) => entry.message === "traxxx: lane complete")?.fields, {
    records: 2,
    emitted: 1,
    filtered: 1,
    excluded: 0,
  });
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

test("a full foreign page is skipped and later matching scenes are fetched until a short page", async () => {
  const pages: number[] = [];
  const adapter = createTraxxxStudio({
    id: "network-vixen-anal",
    name: "Vixen",
    kind: "network",
    slug: "vixen",
    tags: ["anal"],
  });
  const result = await adapter.fetch("2026-01-01", {
    fetcher: {
      fetch: async (url) => {
        const parsed = new URL(url);
        if (!parsed.searchParams.has("tags")) {
          return Response.json({ scenes: [], total: 100, limit: 1 });
        }
        const page = Number(parsed.searchParams.get("page"));
        pages.push(page);
        assert.ok(page <= 3, "pagination must stop on the short page");
        const scenes =
          page === 1
            ? [
                { id: 1, title: "Foreign old", date: "2025-01-01", network: { slug: "other" } },
                { id: 2, title: "Foreign recent", date: "2026-03-04", network: { slug: "other" } },
              ]
            : Array.from({ length: page === 2 ? 2 : 1 }, (_, index) => ({
                id: page * 10 + index,
                title: "Matching",
                date: "2026-03-04",
                network: { slug: "vixen" },
              }));
        return Response.json({ scenes, total: 5, limit: 2 });
      },
      text: async () => "",
      json: async <T = unknown>() => ({}) as T,
    },
    now: new Date("2026-03-05T00:00:00Z"),
    log: () => {},
    traxxx: { minIntervalMs: 0 },
    mapWithConcurrency: async (items, task) => Promise.all(items.map(task)),
    mapIsolated: async (items, task) => Promise.all(items.map(task)),
  });
  assert.deepEqual(pages, [1, 2, 3]);
  assert.deepEqual(
    result.scenes.map((scene) => scene.sourceSceneId),
    ["20", "21", "30"],
  );
});
