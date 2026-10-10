/**
 * One sync cycle, end to end against a real (in-memory) SQLite store and fake
 * sources. This is where the three properties that no unit test can cover live:
 *
 *  - one failing source does not stop the others;
 *  - a source that returns nothing WITHOUT claiming it is empty fails the run
 *    and keeps its last-good rows (a parser bug must not delete a catalogue);
 *  - a repeat sync converges on the same rows instead of duplicating them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSync,
  dateOnly,
  mergeStudioMetadata,
  normaliseScene,
  type SyncLookups,
} from "../src/pipeline/sync.ts";
import { createSingleFlight } from "../src/pipeline/scheduler.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { RETIRED_SOURCE_IDS } from "../src/sources/registry.ts";
import { NullLogger } from "../src/core/logger.ts";
import { HttpFetcher } from "../src/core/fetcher.ts";
import { fixedClock } from "../src/sources/types.ts";
import type { Scene } from "../src/core/schema.ts";
import { createProgressTracker, type SyncProgress } from "../src/pipeline/progress.ts";
import { poolResultAsEpornerMatches, type LegacyPoolMatch } from "./helpers.ts";
import type { RawScene, SourceAdapter, SourceResult } from "../src/sources/types.ts";

const NOW = "2026-03-10T00:00:00Z";
const FROM = dateOnly(new Date(new Date("2026-03-10T00:00:00Z").getTime() - 90 * 86_400_000));

function raw(id: string, over: Partial<RawScene> = {}): RawScene {
  return {
    sourceSceneId: id,
    title: `Scene ${id}`,
    releaseDate: "2026-03-01",
    performers: ["Marfe"],
    durationSec: 600,
    source: "test",
    provenance: { source: "test" },
    ...over,
  };
}

function adapter(
  id: string,
  fetch: () => Promise<SourceResult>,
  matcher: string | null = "sxyprn+eporner",
): SourceAdapter {
  return {
    id,
    name: id,
    authority: { name: "test", url: `https://example.test/${id}`, role: "catalogue source" },
    matcher,
    fetch,
  };
}

function buildSync(
  store: SqliteStore,
  sources: SourceAdapter[],
  windowDays = 90,
  fetcher: HttpFetcher = new HttpFetcher(),
  retiredSourceIds: readonly string[] = [],
) {
  return createSync({
    store,
    sources,
    retiredSourceIds,
    fetcher,
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays,
    fetchConcurrency: 2,
    lookups: { epornerLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
  });
}

test("studio metadata merge keeps fresh studio fields and falls back to previous studio values", () => {
  const source = adapter("metadata", async () => ({ scenes: [], verifiedEmpty: true }));
  const fieldProvenance = {
    title: "studio-site",
    releaseDate: "studio-site",
    performers: "studio-site",
    durationSec: "studio-site",
    thumbnailUrl: "studio-site",
    tags: "studio-site",
  };
  const previous = normaliseScene(
    source,
    raw("updated", {
      thumbnailUrl: "https://example.test/old.jpg",
      tags: ["Old"],
      fieldProvenance,
    }),
    new Date(NOW),
  );
  const fresh = raw("updated", {
    title: "Updated studio title",
    releaseDate: "2026-03-02",
    performers: ["Updated Performer"],
    durationSec: 900,
    thumbnailUrl: "https://example.test/new.jpg",
    tags: ["New"],
    fieldProvenance,
  });

  assert.deepEqual(mergeStudioMetadata(fresh, null, previous), { ...fresh, metadataPoor: false });
  const fallback = mergeStudioMetadata(
    { ...fresh, fieldProvenance: { title: "catalogue" } },
    null,
    previous,
  );
  assert.equal(fallback.title, previous.title);
  assert.equal(fallback.durationSec, previous.durationSec);
});

test("sync preserves prior studio metadata only for Traxxx records not selected for lookup", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  // Each record gets its OWN release URL. A shared one would make these four
  // distinct records look like one release described four times, which the
  // cross-lane dedup now (correctly) collapses - a fixture artifact, not a
  // behaviour this test is about.
  const releaseUrl = "https://www.tushy.com/videos/example";
  const url = (id: string) => `https://www.tushy.com/videos/${id}`;
  const scenes = [
    raw("direct", { releaseUrl }),
    raw("no-url", { source: "traxxx.me" }),
    raw("unsupported", { source: "traxxx.me", releaseUrl: "https://example.test/scene" }),
    raw("cooldown", { source: "traxxx.me", releaseUrl: url("cooldown") }),
    raw("complete", { source: "traxxx.me", releaseUrl: url("complete") }),
  ];
  const source = adapter("metadata", async () => ({ scenes, verifiedEmpty: false }));
  const studioMetadata = {
    title: "Old title",
    releaseDate: "2026-03-02",
    performers: ["Studio Performer"],
    durationSec: 900,
    thumbnailUrl: "https://example.test/studio.jpg",
    tags: ["Studio"],
  };
  const fieldProvenance = {
    title: "studio-site",
    releaseDate: "studio-site",
    performers: "studio-site",
    durationSec: "studio-site",
    thumbnailUrl: "studio-site",
  };
  try {
    for (const scene of scenes) {
      store.upsertScene(
        normaliseScene(
          source,
          {
            ...scene,
            ...studioMetadata,
            fieldProvenance: {
              ...fieldProvenance,
              ...(scene.sourceSceneId === "complete" ? { tags: "studio-site" } : {}),
            },
          },
          new Date(NOW),
          undefined,
          scene.sourceSceneId === "cooldown" ? new Date(NOW).toISOString() : null,
        ),
      );
    }
    const summary = await buildSync(store, [source], 90, offlineFetcher())("test");
    assert.equal(summary.ok, true);
    for (const scene of scenes) {
      const saved = store.getScene(`metadata:${scene.sourceSceneId}`);
      assert.ok(saved);
      const isTraxxx = scene.source === "traxxx.me";
      for (const field of [
        "title",
        "releaseDate",
        "performers",
        "durationSec",
        "thumbnailUrl",
      ] as const) {
        assert.deepEqual(
          saved[field],
          isTraxxx ? studioMetadata[field] : (scene[field] ?? ""),
          `${scene.sourceSceneId}: ${field}`,
        );
      }
      assert.deepEqual(saved.tags, scene.sourceSceneId === "complete" ? studioMetadata.tags : []);
      assert.deepEqual(
        saved.fieldProvenance,
        isTraxxx
          ? {
              ...fieldProvenance,
              ...(scene.releaseUrl ? { releaseUrl: "metadata" } : {}),
              ...(scene.sourceSceneId === "complete" ? { tags: "studio-site" } : {}),
            }
          : Object.fromEntries(
              ["title", "releaseDate", "performers", "durationSec", "thumbnailUrl", "releaseUrl"]
                .filter((field) => {
                  const value = scene[field as keyof typeof scene];
                  return (
                    value !== undefined &&
                    value !== null &&
                    value !== "" &&
                    !(Array.isArray(value) && !value.length)
                  );
                })
                .map((field) => [field, "metadata"]),
            ),
        scene.sourceSceneId,
      );
      assert.equal(
        saved.studioMetadataCheckedAt,
        scene.sourceSceneId === "cooldown" ? new Date(NOW).toISOString() : null,
        scene.sourceSceneId,
      );
    }
  } finally {
    store.close();
  }
});

test("studio metadata attempt time survives normalization and a store round trip", () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const studioMetadataCheckedAt = "2026-03-10T00:00:00.000Z";
  const source = adapter("metadata", async () => ({ scenes: [], verifiedEmpty: true }));
  try {
    const first = normaliseScene(
      source,
      raw("checked"),
      new Date(NOW),
      undefined,
      studioMetadataCheckedAt,
    );
    store.upsertScene(first);
    const saved = store.getScene("metadata:checked");
    assert.equal(saved?.studioMetadataCheckedAt, studioMetadataCheckedAt);

    const refreshed = normaliseScene(source, raw("checked"), new Date(NOW), saved);
    assert.equal(refreshed.studioMetadataCheckedAt, studioMetadataCheckedAt);
  } finally {
    store.close();
  }
});

test("sync prefers exact studio metadata and keeps Traxxx values for fields the page omits", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let calls = 0;
  const fetcher = {
    async fetch() {
      calls += 1;
      return new Response(
        JSON.stringify({
          data: {
            findOneVideo: {
              slug: "hotel-vixen-season-3-episode-12-it-got-better",
              title: "Studio title",
              releaseDate: "2026-03-01T00:00:00Z",
              runLength: "00:25:51",
              models: [{ name: "Nicole Kitt" }],
              categories: [{ name: "Anal" }],
              images: { poster: [] },
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    async text() {
      throw new Error("unused");
    },
    async json() {
      throw new Error("unused");
    },
  };
  const sync = createSync({
    store,
    sources: [
      adapter("traxxx-watchlist", async () => ({
        scenes: [
          raw("vixen-1", {
            source: "traxxx.me",
            studioId: "tushy",
            studio: "Tushy",
            releaseUrl:
              "https://www.tushy.com/videos/hotel-vixen-season-3-episode-12-it-got-better",
            durationSec: 1500,
            performers: ["Traxxx Performer"],
          }),
        ],
        verifiedEmpty: false,
      })),
    ],
    fetcher,
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { epornerLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
  });
  try {
    await sync("test");
    const scene = store.getScene("traxxx-watchlist:tushy:vixen-1");
    assert.equal(calls, 1);
    assert.equal(scene?.title, "Studio title");
    assert.equal(scene?.durationSec, 1551);
    assert.deepEqual(scene?.performers, ["Nicole Kitt"]);
    assert.equal(scene?.fieldProvenance.durationSec, "studio-site");
    assert.equal(scene?.studioMetadataCheckedAt, new Date(NOW).toISOString());
  } finally {
    store.close();
  }
});

test("a corrected release URL is read again, even inside the retry interval", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const OLD_URL = "https://www.tushy.com/videos/hotel-vixen-season-3-episode-12-it-got-better";
  const NEW_URL = "https://www.tushy.com/videos/hotel-vixen-season-3-episode-13-the-fix";
  let releaseUrl = OLD_URL;
  const requested: string[] = [];
  const fetcher = {
    async fetch(_url: string, options: { body?: string } = {}) {
      const request = JSON.parse(options.body ?? "{}") as {
        variables?: { videoSlug?: string };
      };
      requested.push(request.variables?.videoSlug ?? "");
      return new Response(
        JSON.stringify({
          data: {
            findOneVideo: {
              slug: request.variables?.videoSlug,
              title: "Studio title",
              releaseDate: "2026-03-01T00:00:00Z",
              runLength: "00:25:51",
              models: [{ name: "Nicole Kitt" }],
              categories: [],
              images: { poster: [] },
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    async text() {
      throw new Error("unused");
    },
    async json() {
      throw new Error("unused");
    },
  };
  const source = adapter("traxxx-watchlist", async () => ({
    scenes: [
      raw("vixen-1", {
        source: "traxxx.me",
        studioId: "tushy",
        releaseUrl,
        fieldProvenance: {},
      }),
    ],
    verifiedEmpty: false,
  }));
  const sync = createSync({
    store,
    sources: [source],
    fetcher,
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { epornerLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
  });
  try {
    await sync("first");
    assert.equal(store.getScene("traxxx-watchlist:tushy:vixen-1")?.title, "Studio title");
    // The page is complete and the retry interval has not passed, so only a
    // changed release URL can make the cycle read it again.
    releaseUrl = NEW_URL;
    await sync("corrected");
    assert.deepEqual(requested, [
      "hotel-vixen-season-3-episode-12-it-got-better",
      "hotel-vixen-season-3-episode-13-the-fix",
    ]);
  } finally {
    store.close();
  }
});

test("incomplete studio metadata retries only after 24 hours", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let now = new Date(NOW);
  let calls = 0;
  const fetcher = {
    async fetch() {
      calls += 1;
      return new Response(
        JSON.stringify({
          data: {
            findOneVideo: {
              slug: "hotel-vixen-season-3-episode-12-it-got-better",
              runLength: "00:25:51",
            },
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
    async text() {
      throw new Error("unused");
    },
    async json() {
      throw new Error("unused");
    },
  };
  const sync = createSync({
    store,
    sources: [
      adapter("traxxx-watchlist", async () => ({
        scenes: [
          raw("vixen-1", {
            source: "traxxx.me",
            studioId: "tushy",
            releaseUrl:
              "https://www.tushy.com/videos/hotel-vixen-season-3-episode-12-it-got-better",
          }),
        ],
        verifiedEmpty: false,
      })),
    ],
    fetcher,
    clock: { now: () => new Date(now) },
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { epornerLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
  });
  try {
    await sync("first");
    now = new Date(new Date(NOW).getTime() + 23 * 60 * 60 * 1000);
    await sync("too-soon");
    assert.equal(calls, 1);
    now = new Date(new Date(NOW).getTime() + 24 * 60 * 60 * 1000);
    await sync("due");
    assert.equal(calls, 2);
  } finally {
    store.close();
  }
});

test("studio detail lookups are capped at 50 scenes per sync", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let calls = 0;
  const fetcher = {
    async fetch(_url: string, options: { body?: string } = {}) {
      calls += 1;
      const request = JSON.parse(options.body ?? "{}") as {
        variables?: { videoSlug?: string };
      };
      return new Response(
        JSON.stringify({ data: { findOneVideo: { slug: request.variables?.videoSlug } } }),
        { headers: { "content-type": "application/json" } },
      );
    },
    async text() {
      throw new Error("unused");
    },
    async json() {
      throw new Error("unused");
    },
  };
  const scenes = Array.from({ length: 51 }, (_, index) => {
    const slug = `tushy-release-${index}`;
    return raw(String(index), {
      source: "traxxx.me",
      studioId: "tushy",
      releaseUrl: `https://www.tushy.com/videos/${slug}`,
    });
  });
  const source = adapter("traxxx-watchlist", async () => ({ scenes, verifiedEmpty: false }));
  const sync = createSync({
    store,
    sources: [source],
    fetcher,
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { epornerLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
  });
  try {
    for (const index of [0, 50]) {
      store.upsertScene(
        normaliseScene(
          source,
          { ...scenes[index]!, title: "Old title", fieldProvenance: { title: "studio-site" } },
          new Date(NOW),
        ),
      );
    }
    await sync("test");
    assert.equal(calls, 50);
    assert.ok(store.getScene("traxxx-watchlist:tushy:0")?.studioMetadataCheckedAt);
    assert.equal(store.getScene("traxxx-watchlist:tushy:0")?.title, "Old title");
    assert.equal(store.getScene("traxxx-watchlist:tushy:50")?.studioMetadataCheckedAt, null);
    assert.equal(store.getScene("traxxx-watchlist:tushy:50")?.title, "Old title");
    assert.deepEqual(store.getScene("traxxx-watchlist:tushy:50")?.fieldProvenance, {
      title: "studio-site",
      releaseDate: "traxxx-watchlist",
      performers: "traxxx-watchlist",
      durationSec: "traxxx-watchlist",
      releaseUrl: "traxxx-watchlist",
    });
  } finally {
    store.close();
  }
});
/**
 * A fetcher that fails every request.
 *
 * The FC2 lane now talks to a real site rather than throwing a named stub error,
 * so the tests that care about its FAILURE BEHAVIOUR need a way to make the
 * network fail without touching the network. `HttpFetcher` already turns any
 * rejection into a `FetchError`, so denying the transport is enough.
 */
function offlineFetcher(): HttpFetcher {
  const denied = {
    fetch: async () => {
      throw new Error("network disabled in tests");
    },
  };
  return new Proxy(new HttpFetcher(), {
    get(target, property) {
      if (property === "fetch") return denied.fetch;
      const value = Reflect.get(target, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("one failing source does not stop the others", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("good", async () => ({ scenes: [raw("1"), raw("2")], verifiedEmpty: false })),
    adapter("bad", async () => {
      throw new Error("upstream is down");
    }),
  ]);

  const summary = await sync("test");
  const bySource = new Map(summary.outcomes.map((entry) => [entry.source, entry]));
  assert.equal(bySource.get("good")?.ok, true);
  assert.equal(bySource.get("good")?.count, 2);
  assert.equal(bySource.get("bad")?.ok, false);
  assert.match(bySource.get("bad")?.error ?? "", /upstream is down/);
  assert.equal(summary.ok, false);
  assert.equal(summary.windowScenes, 2);

  // The failing source keeps an error status, and the healthy one is marked ok.
  const sources = new Map(store.listSources().map((entry) => [entry.sourceId, entry]));
  assert.match(sources.get("bad")?.lastError ?? "", /upstream is down/);
  assert.equal(sources.get("good")?.lastError, null);
  assert.ok(sources.get("good")?.lastSuccessAt);
  store.close();
});

test("source health stores the configured global window on success and failure", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(
    store,
    [
      adapter("madouqu", async () => ({ scenes: [raw("1")], verifiedEmpty: false }), null),
      adapter("broken", async () => {
        throw new Error("upstream is down");
      }),
    ],
    37,
  );

  await sync("test");
  const sources = new Map(store.listSources().map((entry) => [entry.sourceId, entry]));
  assert.equal(sources.get("madouqu")?.windowDays, 37);
  assert.equal(sources.get("broken")?.windowDays, 37);
  store.close();
});

test("one network lane writes child health rows with label-specific final counts", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("vixen-anal", async () => ({
      scenes: [
        raw("1", { studioId: "tushy", studio: "Tushy" }),
        raw("2", { studioId: "blacked", studio: "Blacked" }),
      ],
      verifiedEmpty: false,
      labels: [
        { labelId: "tushy", label: "Tushy", sceneCount: 100 },
        { labelId: "blacked", label: "Blacked", sceneCount: 200 },
      ],
    })),
  ]);

  await sync("test");
  const statuses = new Map(
    store.listSources().map((status) => [status.sourceId + ":" + status.labelId, status]),
  );
  assert.equal(statuses.size, 3);
  assert.equal(statuses.get("vixen-anal:vixen-anal")?.sceneCount, 2);
  assert.equal(statuses.get("vixen-anal:tushy")?.sceneCount, 1);
  assert.equal(statuses.get("vixen-anal:blacked")?.sceneCount, 1);
  assert.deepEqual(
    statuses.get("vixen-anal:tushy")?.authority,
    statuses.get("vixen-anal:vixen-anal")?.authority,
  );
  assert.equal(
    statuses.get("vixen-anal:tushy")?.lastSuccessAt,
    statuses.get("vixen-anal:vixen-anal")?.lastSuccessAt,
  );
  store.close();
});

test("a failing network lane stamps its existing child rows and keeps their counts", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let healthy = true;
  const sync = buildSync(store, [
    adapter("vixen-anal", async () => {
      if (!healthy) throw new Error("traxxx unavailable");
      return {
        scenes: [raw("1", { studioId: "tushy", studio: "Tushy" })],
        verifiedEmpty: false,
        labels: [{ labelId: "tushy", label: "Tushy", sceneCount: 1 }],
      };
    }),
  ]);
  await sync("first");
  healthy = false;
  await sync("second");

  const child = store
    .listSources()
    .find((status) => status.sourceId === "vixen-anal" && status.labelId === "tushy");
  assert.match(child?.lastError ?? "", /traxxx unavailable/);
  assert.equal(child?.sceneCount, 1);
  assert.ok(child?.lastSuccessAt);
  store.close();
});

test("scene and child health writes are atomic for one lane", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const upsertSource = store.upsertSource.bind(store);
  store.upsertSource = (status) => {
    if (status.labelId === "tushy") throw new Error("child health write failed");
    upsertSource(status);
  };
  const sync = buildSync(store, [
    adapter("vixen-anal", async () => ({
      scenes: [raw("1", { studioId: "tushy", studio: "Tushy" })],
      verifiedEmpty: false,
      labels: [{ labelId: "tushy", label: "Tushy", sceneCount: 1 }],
    })),
  ]);

  const summary = await sync("test");
  assert.equal(summary.outcomes[0]?.ok, false);
  assert.equal(store.getScene("vixen-anal:tushy:1"), null);
  store.close();
});

test("explicit retirement prunes only named source ids and keeps a failing active lane", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const retired = adapter("tushy", async () => ({ scenes: [], verifiedEmpty: true }));
  store.upsertScene(normaliseScene(retired, raw("old"), new Date(NOW)));
  let activeFails = false;
  const sync = buildSync(
    store,
    [
      adapter("active", async () => {
        if (activeFails) throw new Error("temporary outage");
        return { scenes: [raw("current")], verifiedEmpty: false };
      }),
    ],
    90,
    new HttpFetcher(),
    RETIRED_SOURCE_IDS,
  );
  await sync("healthy");
  activeFails = true;
  await sync("outage");

  assert.equal(store.getScene("tushy:old"), null);
  assert.equal(RETIRED_SOURCE_IDS.includes("maximo-garcia"), false);
  assert.ok(store.getScene("active:current"));
  assert.deepEqual(
    store.listSources().map((status) => status.sourceId),
    ["active"],
  );
  assert.match(store.listSources()[0]?.lastError ?? "", /temporary outage/);
  store.close();
});

test("an empty result that does not claim to be verified is a failure", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("suspicious", async () => ({ scenes: [], verifiedEmpty: false })),
  ]);
  const summary = await sync("test");
  assert.equal(summary.outcomes[0]?.ok, false);
  assert.match(summary.outcomes[0]?.error ?? "", /suspicious/);
  store.close();
});

test("a source that genuinely has nothing is a clean success", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("empty", async () => ({ scenes: [], verifiedEmpty: true })),
  ]);
  const summary = await sync("test");
  assert.equal(summary.outcomes[0]?.ok, true);
  assert.equal(summary.outcomes[0]?.count, 0);
  store.close();
});

test("all invalid records fail the source, while valid siblings are retained", async () => {
  const emptyStore = new SqliteStore(":memory:");
  emptyStore.migrate();
  const invalidOnly = buildSync(emptyStore, [
    adapter("invalid-only", async () => ({
      scenes: [raw("bad", { title: "" })],
      verifiedEmpty: false,
    })),
  ]);
  const failed = await invalidOnly("test");
  assert.equal(failed.outcomes[0]?.ok, false);
  assert.match(failed.outcomes[0]?.error ?? "", /all records/);
  assert.equal(emptyStore.listSources()[0]?.lastSuccessAt, null);
  emptyStore.close();

  const mixedStore = new SqliteStore(":memory:");
  mixedStore.migrate();
  const mixed = buildSync(mixedStore, [
    adapter("mixed", async () => ({
      scenes: [raw("good"), raw("bad", { title: "" })],
      verifiedEmpty: false,
    })),
  ]);
  const partial = await mixed("test");
  assert.equal(partial.outcomes[0]?.ok, true);
  assert.equal(partial.outcomes[0]?.count, 1);
  assert.ok(mixedStore.getScene("mixed:good"));
  mixedStore.close();
});

test("a failed poll keeps the source's last-good in-window rows", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let healthy = true;
  const flaky = adapter("flaky", async () => {
    if (!healthy) throw new Error("temporarily hidden upstream");
    return { scenes: [raw("1"), raw("2")], verifiedEmpty: false };
  });
  const sync = buildSync(store, [flaky]);

  await sync("first");
  assert.equal(store.listWindow(FROM, "2026-03-10").length, 2);
  const prior = store
    .listProviderObservations()
    .map((item) => item.recordId)
    .sort();
  assert.deepEqual(prior, ["1", "2"]);

  healthy = false;
  const second = await sync("second");
  assert.equal(second.outcomes[0]?.ok, false);
  // Retention: the records a temporarily-failing upstream omitted survive.
  assert.equal(store.listWindow(FROM, "2026-03-10").length, 2);
  assert.deepEqual(
    store
      .listProviderObservations()
      .map((item) => item.recordId)
      .sort(),
    prior,
    "a failed poll leaves provider observations untouched",
  );
  store.close();
});

test("a repeat poll preserves resolved links, dead links and the re-verify watermark", async () => {
  // The bug this covers: `upsertScene` REPLACES `scene_links` from the scene it
  // is handed, and the scene a metadata poll builds knows nothing about
  // playback - so every poll erased every resolved link and every struck one.
  // The resolver's writes survived only for the scenes it happened to change in
  // the same cycle, which is not a property anyone could rely on.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false })),
  ]);

  await sync("first");
  const resolved: Scene = {
    ...(store.getScene("good:1") as Scene),
    videoUrls: [
      {
        source: "eporner",
        url: "https://www.eporner.com/video-live/",
        verifiedAt: "2026-03-05T00:00:00.000Z",
        verifyFailures: 0,
      },
    ],
    deadVideoUrls: [
      {
        source: "eporner",
        url: "https://www.eporner.com/video-dead/",
        deadAt: "2026-03-06T00:00:00.000Z",
        deadReason: "eporner video/id lookup found no record",
      },
    ],
    videoCheckedAt: "2026-03-05T00:00:00.000Z",
    videoMatching: {
      lane: "eporner",
      matchedAt: "2026-03-05T00:00:00.000Z",
      rule: "duration+window",
      confidence: "high",
    },
  };
  store.upsertScene(resolved);

  // Two more polls. One would have been enough to show the loss; two also shows
  // the state is stable rather than decaying.
  await sync("second");
  await sync("third");

  const after = store.getScene("good:1") as Scene;
  assert.deepEqual(
    after.videoUrls.map((link) => link.url),
    ["https://www.eporner.com/video-live/"],
    "a resolved link survives a metadata poll",
  );
  assert.deepEqual(
    after.deadVideoUrls.map((link) => link.url),
    ["https://www.eporner.com/video-dead/"],
    "a struck link stays struck, and its history is not deleted either",
  );
  assert.equal(
    after.videoCheckedAt,
    "2026-03-05T00:00:00.000Z",
    "videoCheckedAt is carried forward, so re-verify still rotates over the genuinely stalest links",
  );
  assert.equal(after.videoMatching?.lane, "eporner");
  store.close();
});

test("a repeat sync converges instead of duplicating", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("good", async () => ({ scenes: [raw("1"), raw("2")], verifiedEmpty: false })),
  ]);

  const first = await sync("first");
  const second = await sync("second");
  assert.equal(first.windowScenes, 2);
  assert.equal(second.windowScenes, 2);
  assert.equal(store.listWindow(FROM, "2026-03-10").length, 2);
  // A second run is recorded too: the ledger is append-only, not idempotent-by-hiding.
  assert.equal(store.recentRuns(10).length, 2);
  store.close();
});

test("scenes that left the rolling window are expired", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("aged", async () => ({
      scenes: [raw("old", { releaseDate: "2020-01-01" }), raw("new")],
      verifiedEmpty: false,
    })),
  ]);
  const summary = await sync("test");
  assert.equal(summary.expired, 1);
  assert.equal(summary.windowScenes, 1);
  assert.equal(store.getScene("aged:old"), null);
  store.close();
});

test("a record that fails the schema boundary is skipped, not fatal to the run", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    // `releaseDate` "not-a-date" cannot cross the boundary.
    adapter("mixed", async () => ({
      scenes: [raw("ok"), raw("broken", { releaseDate: "not-a-date" })],
      verifiedEmpty: false,
    })),
  ]);
  const summary = await sync("test");
  assert.equal(summary.outcomes[0]?.ok, true);
  assert.equal(summary.outcomes[0]?.count, 1);
  assert.equal(store.getScene("mixed:broken"), null);
  assert.ok(store.getScene("mixed:ok"));
  store.close();
});

test("the run ledger records each cycle with its outcomes", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false })),
  ]);
  await sync("test");
  const [run] = store.recentRuns(1);
  assert.ok(run);
  assert.equal(run?.kind, "sync");
  assert.equal(run?.ok, true);
  assert.ok(run?.endedAt);
  assert.equal(run?.outcomes.length, 1);
  store.close();
});

test("run ledger keeps resolver errors separate from catalogue source health", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildResolvingSync(
    store,
    [adapter("healthy-catalogue", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    {
      sxyprnLookup: async () => {
        throw new Error("sxyprn timed out");
      },
    },
  );

  const summary = await sync("test");
  const [run] = store.recentRuns(1);
  assert.equal(summary.ok, true, "resolver outages do not mark catalogue polling as failed");
  assert.equal(store.listSources()[0]?.lastError, null);
  assert.equal(run?.resolverHealth?.attempted, 1);
  assert.equal(run?.resolverHealth?.errored, 1);
  assert.equal(run?.outcomes[0]?.ok, true);
  store.close();
});

test("the run ledger splits the winners it counted, so a guess is never read as a match", async () => {
  // `matched` is one number over two different things: a rung that NAMED the scene,
  // and the terminal fallback's flagged guess when no tube could. Both are stored
  // as links and both read as "matched", so a run can report 69 matched when 13
  // were identified - and the only way to see that was to reconstruct it from
  // other counters. These three numbers are the direct reading.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const named = (over: Partial<LegacyPoolMatch>): LegacyPoolMatch => ({
    url: "https://www.eporner.com/video-abc/",
    embedUrl: "https://www.eporner.com/embed/abc/",
    videoId: "abc",
    uploader: "Vovick17",
    title: "Marfe compilation",
    identityTier: 1,
    lagDays: 2,
    candidatesConsidered: 40,
    durationPassed: 1,
    hydrated: 1,
    rejectedByDate: 0,
    unknownDate: 0,
    hydrationCapped: false,
    omittedCandidates: 0,
    fallbackCandidates: [],
    rejected: null,
    ...over,
  });
  const sync = buildResolvingSync(
    store,
    [
      adapter("pooled", async () => ({
        scenes: [raw("1"), raw("2"), raw("3")],
        verifiedEmpty: false,
      })),
    ],
    {
      // Scene 1 is named by Eporner, scene 2 by Sxyprn, and scene 3 only has an
      // unnamed survivor for the low-confidence fallback.
      epornerLookup: async (scene) =>
        scene.id === "pooled:1"
          ? named({})
          : named({ url: "", embedUrl: "", videoId: "", title: "", rejected: "date" }),
      sxyprnLookup: async (scene) => {
        const slug =
          scene.id === "pooled:1"
            ? "0000000000001"
            : scene.id === "pooled:2"
              ? "0000000000002"
              : "0000000000003";
        const url = `https://sxyprn.com/post/${slug}.html`;
        const named = scene.id === "pooled:2";
        return [
          {
            url,
            identityTier: named ? (2 as const) : (0 as const),
            lagDays: 1,
            title: named ? "Marfe compilation" : "unrelated clip",
            duration: 600,
            added: "2026-03-02T00:00:00.000Z",
            views: 900,
          },
        ];
      },
    },
  );

  const summary = await sync("test");
  const [run] = store.recentRuns(1);
  const health = run?.resolverHealth ?? {};
  assert.equal(summary.matched, 3, "all three are links, and all three count as matched");
  assert.equal(health.winnerEporner, 1);
  assert.equal(health.winnerSxyprn, 1);
  assert.equal(health.winnerFallback, 1, "the guess is visible as its own number");
  assert.equal(
    (health.winnerEporner ?? 0) + (health.winnerSxyprn ?? 0),
    2,
    "the two named counters separate the rungs, which no other counter on the row does",
  );
  store.close();
});

/** A sync with the resolve stage switched on, for the ladder's end-to-end tests. */
function buildResolvingSync(
  store: SqliteStore,
  sources: SourceAdapter[],
  lookups: Omit<Partial<SyncLookups>, "epornerLookup"> & {
    epornerLookup?:
      | ((
          scene: Parameters<NonNullable<SyncLookups["epornerLookup"]>>[0],
        ) => Promise<LegacyPoolMatch | null>)
      | null;
  } = {},
) {
  const { epornerLookup: legacyLookup, ...otherLookups } = lookups;
  return createSync({
    store,
    sources,
    fetcher: new HttpFetcher(),
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: {
      sxyprnLookup: null,
      ...otherLookups,
      epornerLookup: legacyLookup
        ? async (scene) => poolResultAsEpornerMatches(await legacyLookup(scene), scene)
        : null,
    },
  });
}

test("an Eporner result outside the date window is refused end to end", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  // The scene's release date is 2026-03-01. A pool candidate uploaded three
  // weeks later is outside any sane window, so no URL may be written - the
  // rung reports the rejection and the scene stays unlinked for a later cycle.
  const sync = buildResolvingSync(
    store,
    [adapter("pooled", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    {
      epornerLookup: async () => ({
        url: "",
        embedUrl: "",
        videoId: "",
        uploader: "Vovick17",
        title: "Marfe compilation",
        identityTier: 0,
        lagDays: 21,
        candidatesConsidered: 40,
        durationPassed: 1,
        hydrated: 1,
        rejectedByDate: 1,
        unknownDate: 0,
        hydrationCapped: false,
        omittedCandidates: 0,
        fallbackCandidates: [],
        rejected: "date",
      }),
    },
  );
  const summary = await sync("test");
  assert.equal(summary.matched, 0, "nothing was linked");
  assert.equal(summary.rejections.noMatch, 1, "the rejected result is not linked");
  const scene = store.getScene("pooled:1");
  assert.ok(scene);
  assert.equal(scene.videoUrls.length, 0, "a missing link beats a wrong one");
  // Retried next cycle, never written off.
  assert.equal(scene.deadVideoUrls.length, 0);
  assert.ok(scene.videoCheckedAt, "but it is stamped as checked");
  store.close();
});

test("an in-window pool match IS linked, and the winner's tier drives confidence", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildResolvingSync(
    store,
    [adapter("pooled", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    {
      epornerLookup: async () => ({
        url: "https://www.eporner.com/video-abc/",
        embedUrl: "https://www.eporner.com/embed/abc/",
        videoId: "abc",
        uploader: "Vovick17",
        title: "Marfe compilation",
        identityTier: 1,
        lagDays: 2,
        candidatesConsidered: 40,
        durationPassed: 1,
        hydrated: 1,
        rejectedByDate: 0,
        unknownDate: 0,
        hydrationCapped: false,
        omittedCandidates: 0,
        fallbackCandidates: [],
        rejected: null,
      }),
    },
  );
  const summary = await sync("test");
  assert.equal(summary.matched, 1);
  assert.deepEqual(summary.winners, [{ rung: "eporner", tier: 1 }]);
  const scene = store.getScene("pooled:1");
  assert.ok(scene, "the scene is still stored, just unlinked");
  assert.equal(scene.videoUrls[0]?.url, "https://www.eporner.com/video-abc/");
  assert.equal(scene.videoMatching?.confidence, "high");
  assert.equal(scene.videoMatching?.lane, "eporner");
  store.close();
});

test("a tier-0 winner is recorded as LOW CONFIDENCE for eyeballing", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildResolvingSync(
    store,
    [adapter("pooled", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    {
      epornerLookup: async () => ({
        url: "https://www.eporner.com/video-abc/",
        embedUrl: "https://www.eporner.com/embed/abc/",
        videoId: "abc",
        uploader: "Vovick17",
        title: "unrelated clip",
        identityTier: 0,
        lagDays: 2,
        candidatesConsidered: 40,
        durationPassed: 3,
        hydrated: 3,
        rejectedByDate: 0,
        unknownDate: 0,
        hydrationCapped: false,
        omittedCandidates: 0,
        fallbackCandidates: [],
        rejected: null,
      }),
    },
  );
  await sync("test");
  const scene = store.getScene("pooled:1");
  assert.ok(scene);
  assert.equal(scene.videoMatching?.confidence, "low");
  assert.equal(scene.videoUrls.length, 1, "it is still linked - flagged, not withheld");
  store.close();
});

test("a metadata-only lane produces ZERO links after the gate rewrite", async () => {
  // A scope regression guard, not a target. madouqu keeps `matcher: null`, and
  // the gate rewrite must not have made it start linking - especially not by
  // inferring eligibility from the data.
  //
  // FC2 is NOT in this test any more. It stopped being a metadata-only stub when
  // its lane was implemented, and it is covered by test/fc2cmadb.test.ts instead;
  // leaving it here would assert a behaviour the app deliberately no longer has.
  const store = new SqliteStore(":memory:");
  store.migrate();
  let consulted = 0;
  const count = async (): Promise<LegacyPoolMatch> => {
    consulted += 1;
    return {
      url: "https://www.eporner.com/video-abc/",
      embedUrl: "https://www.eporner.com/embed/abc/",
      videoId: "abc",
      uploader: "Vovick17",
      title: "anything",
      identityTier: 3,
      lagDays: 0,
      candidatesConsidered: 1,
      durationPassed: 1,
      hydrated: 1,
      rejectedByDate: 0,
      unknownDate: 0,
      hydrationCapped: false,
      omittedCandidates: 0,
      fallbackCandidates: [],
      rejected: null,
    };
  };
  const sync = buildResolvingSync(
    store,
    [adapter("madouqu", async () => ({ scenes: [raw("1")], verifiedEmpty: false }), null)],
    { epornerLookup: count },
  );
  const summary = await sync("test");
  assert.equal(summary.matched, 0, "the metadata-only lane did not link");
  assert.equal(summary.rejections.attempted, 0, "the ladder was never entered for it");
  assert.equal(consulted, 0, "no rung was even asked");
  assert.equal(store.getScene("madouqu:1")?.videoUrls.length ?? 0, 0, "it stayed unlinked");
  store.close();
});

test("the fc2cmadb lane fails cleanly when the site is unreachable", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const { createFc2CmadbStudio } = await import("../src/sources/fc2cmadb.ts");
  const sync = buildSync(
    store,
    [
      createFc2CmadbStudio({ sleep: async () => {} }),
      adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false })),
    ],
    90,
    offlineFetcher(),
  );
  const summary = await sync("test");
  const outcomes = new Map(summary.outcomes.map((entry) => [entry.source, entry]));
  assert.equal(outcomes.get("good")?.ok, true);
  assert.equal(summary.windowScenes, 1);
  // An unreachable site throws rather than returning an empty result, so the lane
  // cannot trip the suspicious-empty protection and delete a catalogue it simply
  // failed to read.
  assert.equal(outcomes.get("fc2cmadb")?.ok, false);
  assert.match(outcomes.get("fc2cmadb")?.error ?? "", /fc2cmadb|network/i);
  store.close();
});

test("normaliseScene builds the <source>:<scene> identity and keeps provenance", () => {
  const now = new Date(NOW);
  const scene = normaliseScene(
    adapter("lancelot-styles-evolution", async () => ({ scenes: [], verifiedEmpty: true })),
    raw("4683299", { studioCode: "LS-1" }),
    now,
  );
  assert.equal(scene.id, "lancelot-styles-evolution:4683299");
  assert.equal(scene.labelId, "lancelot-styles-evolution");
  assert.equal(scene.provenance.length, 1);
  assert.equal(scene.provenance[0]?.fetchedAt, now.toISOString());
  assert.equal(scene.studioCode, "LS-1");
});

test("a sub-label becomes its own label identity", () => {
  // The sub-label is part of the KEY, not just of the label fields. madouqu
  // cross-lists the same post into several categories, so with a bare
  // `<source>:<scene>` key those records collided on one row and every category
  // but the last one walked was silently lost.
  const madouqu = adapter("madouqu", async () => ({ scenes: [], verifiedEmpty: true }), null);
  const peach = normaliseScene(
    madouqu,
    raw("123", { studioId: "madouqu-peach", studio: "Peach" }),
    new Date(NOW),
  );
  const jelly = normaliseScene(
    madouqu,
    raw("123", { studioId: "madouqu-jelly-91", studio: "Jelly/91" }),
    new Date(NOW),
  );
  assert.equal(peach.id, "madouqu:madouqu-peach:123");
  assert.equal(peach.labelId, "madouqu-peach");
  assert.equal(peach.label, "Peach");
  assert.notEqual(peach.id, jelly.id, "the same post under two sub-labels is two records");
});

test("a single-label source keeps the two-part key", () => {
  // Widening the key must not churn every existing row of every lane that
  // never emits a sub-label.
  const scene = normaliseScene(
    adapter("lancelot-styles-evolution", async () => ({ scenes: [], verifiedEmpty: true })),
    raw("4683299", { studioCode: "LS-1" }),
    new Date(NOW),
  );
  assert.equal(scene.id, "lancelot-styles-evolution:4683299");
  assert.equal(scene.labelId, "lancelot-styles-evolution");
});

test("single-flight collapses concurrent cycles into one run", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let runs = 0;
  const flight = createSingleFlight(async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return runs;
  });
  const [a, b, c] = await Promise.all([flight(), flight(), flight()]);
  assert.equal(runs, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(c, 1);
  // After settling, a new call starts a fresh cycle.
  assert.equal(await flight(), 2);
  store.close();
});

/* ---- Live progress --------------------------------------------------------
   The dashboard's meters are driven entirely by the tracker, so what matters is
   that the pipeline narrates itself COMPLETELY and WHILE it runs: every source
   accounted for (including the ones that threw), every resolve step counted
   against the queue it actually built, and the run finished. A bar that sits
   short of its total is indistinguishable from a hang. */

function progressSync(store: SqliteStore, over: Partial<Parameters<typeof createSync>[0]>) {
  return createSync({
    store,
    sources: [],
    fetcher: new HttpFetcher(),
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { epornerLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
    ...over,
  });
}

test("progress is live mid-run, and a source that throws still counts as an attempt", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const progress = createProgressTracker();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Concurrency 1 makes the order deterministic: the first source completes,
  // then the second starts and hangs, which is the moment worth inspecting.
  let midRun: SyncProgress | null = null;
  const sync = progressSync(store, {
    sources: [
      adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false })),
      adapter("bad", async () => {
        midRun = progress.snapshot();
        await gate;
        throw new Error("upstream is down");
      }),
    ],
    fetchConcurrency: 1,
    progress,
  });

  const started = sync("test");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(midRun, "the run reached the second source");
  const live = midRun as SyncProgress;
  assert.equal(live.active, true, "a reader can see the cycle while it is still working");
  assert.equal(live.stage, "populating");
  assert.equal(live.populate.done, 1, "the first source is already counted");
  assert.equal(live.populate.total, 2);
  assert.deepEqual(live.populate.current, ["bad"], "the source in flight is named");

  release();
  const summary = await started;
  assert.equal(summary.ok, false, "the throwing source still failed the run");
  const after = progress.snapshot();
  assert.equal(after.populate.done, 2, "a failed source is an ATTEMPT, so the bar still fills");
  assert.deepEqual(after.populate.current, []);
  assert.equal(after.active, false, "the bar collapsed when the run ended");
  assert.equal(after.stage, "idle");
  store.close();
});

test("a cycle with the links stage switched off still finishes cleanly", async () => {
  // `--no-links` runs never enter the resolve stage, so the Linking meter has no
  // countable total - and the run must still end, or that bar hangs forever.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const progress = createProgressTracker();
  const sync = progressSync(store, {
    sources: [adapter("only", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    progress,
  });
  await sync("test");
  const snapshot = progress.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.populate.done, 1);
  assert.equal(snapshot.link.total, 0, "nothing was queued, so nothing can be counted");
  assert.equal(snapshot.link.done, 0);
  assert.equal(snapshot.link.verifyTotal, 0);
  store.close();
});

test("a cycle with no sources at all still finishes", async () => {
  // Zero sources is the degenerate case the meters have to survive: no
  // denominator anywhere, and a row that must still collapse when the run ends.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const progress = createProgressTracker();
  const summary = await progressSync(store, { progress })("test");
  const snapshot = progress.snapshot();
  assert.equal(summary.outcomes.length, 0);
  assert.equal(snapshot.populate.total, 0);
  assert.equal(snapshot.populate.done, 0);
  assert.equal(snapshot.active, false);
  store.close();
});

test("the resolve stage counts the queue it built, not the whole window", async () => {
  // Four scenes land in the window; `lookups.limit` cuts the queue to two. A
  // denominator taken from the window would render a bar stuck at 50%.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const progress = createProgressTracker();
  const denominators = new Set<number>();
  const tap = createProgressTracker();
  tap.begin("tap", NOW, { sources: 1, uploaders: 0 });
  const sync = progressSync(store, {
    sources: [
      adapter("many", async () => ({
        scenes: [raw("1"), raw("2"), raw("3"), raw("4")],
        verifiedEmpty: false,
      })),
    ],
    resolveEnabled: true,
    lookups: { epornerLookup: null, sxyprnLookup: null, limit: 2 },
    progress: {
      ...tap,
      linkStep: (done, total, matched) => {
        denominators.add(total);
        tap.linkStep(done, total, matched);
      },
    },
  });
  await sync("test");
  assert.deepEqual([...denominators], [2], "one denominator, and it is the capped queue");
  const snapshot = tap.snapshot();
  assert.equal(snapshot.link.total, 2);
  assert.equal(snapshot.link.done, 2, "the bar reaches 100% at the cap");
  assert.equal(snapshot.link.substage, "verify", "the cycle moved on to re-verify");
  assert.equal(snapshot.active, false);
  assert.equal(progress.snapshot().active, false, "an untouched tracker is still valid");
  store.close();
});

for (const failure of ["ledger", "log"] as const) {
  test(`a failure in the opening ${failure} ends progress and propagates the original error`, async (t) => {
    const store = new SqliteStore(":memory:");
    t.after(() => store.close());
    store.migrate();
    const progress = createProgressTracker();
    const error = new Error(`opening ${failure} failed`);
    const log = new NullLogger();
    if (failure === "ledger")
      t.mock.method(store, "recordRun", () => {
        throw error;
      });
    else
      t.mock.method(log, "info", () => {
        throw error;
      });
    const sync = progressSync(store, { progress, log });
    await assert.rejects(sync("test"), (actual) => actual === error);
    assert.equal(progress.snapshot().active, false);
    assert.equal(progress.snapshot().stage, "error");
    assert.equal(progress.snapshot().populate.done, 0);
  });
}
