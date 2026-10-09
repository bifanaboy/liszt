import assert from "node:assert/strict";
import test from "node:test";
import { createSync, normaliseScene } from "../src/pipeline/sync.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { NullLogger } from "../src/core/logger.ts";
import {
  fixedClock,
  type RawScene,
  type SourceAdapter,
  type Fetcher,
} from "../src/sources/types.ts";
import { applyStudioPolicy } from "../src/sources/studio-policy.ts";
import { createTpdbWatchlistSource } from "../src/sources/tpdb-watchlist.ts";

const NOW = "2026-10-05T00:00:00Z";
const URL = "https://example.test/scene/1";
function record(id: string, fields: Partial<RawScene> = {}): RawScene {
  return {
    sourceSceneId: id,
    title: "Shared title",
    releaseDate: "2026-10-01",
    performers: ["Person"],
    durationSec: 600,
    studioId: "studio",
    releaseUrl: URL,
    ...fields,
  };
}
function source(id: string, records: () => RawScene[]): SourceAdapter {
  return {
    id,
    name: id,
    authority: { name: id, url: "https://example.test", role: "Fixture" },
    matcher: "sxyprn+eporner",
    fetch: async () => ({ scenes: records(), verifiedEmpty: true }),
  };
}
const fetcher: Fetcher = {
  fetch: async () => new Response(""),
  text: async () => "",
  json: async <T>() => ({}) as T,
};
function sync(store: SqliteStore, sources: SourceAdapter[], fetching = fetcher) {
  return createSync({
    store,
    sources,
    retiredSourceIds: [],
    fetcher: fetching,
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { epornerLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
  });
}
function database() {
  const store = new SqliteStore(":memory:");
  store.migrate();
  return store;
}

test("singleton polls rebuild missing fields from retained observations", async () => {
  const store = database();
  try {
    let current = record("one", { thumbnailUrl: "https://example.test/good.jpg" });
    const run = sync(store, [source("provider", () => [current])]);
    await run("initial");
    current = record("one", { durationSec: null, thumbnailUrl: "", performers: [] });
    await run("missing");
    const scene = store.listAll()[0]!;
    assert.equal(scene.durationSec, 600);
    assert.equal(scene.thumbnailUrl, "https://example.test/good.jpg");
    assert.deepEqual(scene.performers, ["Person"]);
    assert.equal(scene.fieldProvenance.durationSec, "provider");
  } finally {
    store.close();
  }
});

test("excluding the canonical provider rebuilds one surviving release and keeps history", async () => {
  const store = database();
  try {
    const first = source("maximo-garcia", () => [record("one", { studioId: "maximo-garcia" })]);
    const second = source("manyvids-1003095958", () => [
      record("two", { studioId: "maximo-garcia", durationSec: 602 }),
    ]);
    const run = sync(store, [first, second]);
    await run("initial");
    const canonical = store.listAll()[0]!;
    canonical.deadVideoUrls = [
      {
        source: "eporner",
        url: "https://www.eporner.com/video-dead/test/",
        deadAt: NOW,
        deadReason: "gone",
      },
    ];
    store.upsertScene(canonical);
    first.fetch = async () => ({ scenes: [], verifiedEmpty: true, excludedSceneIds: ["one"] });
    await run("exclusion");
    const scenes = store.listAll();
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0]!.id, canonical.id);
    assert.equal(scenes[0]!.durationSec, 602);
    assert.equal(scenes[0]!.durationReview, false);
    assert.equal(scenes[0]!.durationRange, undefined);
    assert.deepEqual(scenes[0]!.deadVideoUrls, canonical.deadVideoUrls);
    assert.equal(store.listProviderObservations(canonical.id).length, 1);
  } finally {
    store.close();
  }
});

test("a native TPDB poll replaces its migration backfill without a false conflict", async () => {
  const store = database();
  try {
    const provider = source("tpdb-watchlist", () => [
      record("guid", {
        providerId: "tpdb-site-1",
        providerStudioId: "tpdb-site-1",
        durationSec: 610,
      }),
    ]);
    const legacy = record("guid");
    const scene = normaliseScene(provider, legacy, new Date(NOW));
    store.upsertScene(scene);
    store.upsertProviderObservation({
      providerId: "tpdb-watchlist",
      recordId: "guid",
      studioId: "studio",
      studio: "Studio",
      sceneId: scene.id,
      record: legacy,
      fetchedAt: NOW,
    });
    await sync(store, [provider])("upgraded");
    assert.equal(store.listAll().length, 1);
    assert.equal(store.listAll()[0]!.id, scene.id);
    assert.equal(store.listAll()[0]!.durationSec, 610);
    assert.equal(store.listAll()[0]!.durationReview, false);
    assert.deepEqual(
      store.listProviderObservations().map((item) => item.providerId),
      ["tpdb-site-1"],
    );
  } finally {
    store.close();
  }
});

test("umbrella feeds merge by assigned studio while preserving each native key", async () => {
  const store = database();
  try {
    const feeds = ["first", "second"].map((id) =>
      applyStudioPolicy(
        source(id, () => [record("one", { studioId: `native-${id}` })]),
        {
          adapterId: id,
          sourceUrl: URL,
          studioPolicy: { mode: "umbrella", studioId: "umbrella", studio: "Umbrella" },
        },
      ),
    );
    await sync(store, feeds)("initial");
    const scenes = store.listAll();
    assert.equal(scenes.length, 1);
    assert.equal(scenes[0]!.labelId, "umbrella");
    assert.deepEqual(
      store.listProviderObservations().map((item) => item.studioId),
      ["native-first", "native-second"],
    );
  } finally {
    store.close();
  }
});

const tpdbFetcher: Fetcher = {
  ...fetcher,
  json: async <T>(url: string) =>
    (new globalThis.URL(url).pathname === "/sites"
      ? { data: [{ id: 1, name: "Maximo Garcia" }], meta: { current_page: 1, last_page: 1 } }
      : {
          data: [
            { id: "guid", title: "Shared title", date: "2026-10-01", duration: 600, url: URL },
          ],
          meta: { current_page: 1, last_page: 1 },
        }) as T,
};
function tpdb(studioId: string) {
  return createTpdbWatchlistSource({
    token: "fixture",
    studios: [{ studioId, studio: "Maximo Garcia", aliases: ["Maximo Garcia"], siteIds: [1] }],
  });
}

test("changing a TPDB studio assignment preserves its native identity and canonical ID", async () => {
  const store = database();
  try {
    await sync(store, [tpdb("old-label")], tpdbFetcher)("initial");
    const id = store.listAll()[0]!.id;
    await sync(store, [tpdb("new-label")], tpdbFetcher)("reassigned");
    assert.equal(store.listAll().length, 1);
    assert.equal(store.listAll()[0]!.id, id);
    assert.equal(store.listAll()[0]!.labelId, "new-label");
    assert.equal(store.listProviderObservations().length, 1);
    assert.equal(store.listProviderObservations()[0]!.studioId, "tpdb-site-1");
  } finally {
    store.close();
  }
});

test("composite merging retains verified studio evidence alongside original provider values", async () => {
  const store = database();
  try {
    const url = "https://www.tushy.com/videos/shared-title";
    const providers = [
      source("traxxx", () => [record("one", { source: "traxxx.me", releaseUrl: url })]),
      source("tpdb-watchlist", () => [
        record("two", { providerId: "tpdb-site-1", releaseUrl: url, durationSec: 601 }),
      ]),
    ];
    const fetching = {
      ...fetcher,
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              findOneVideo: {
                slug: "shared-title",
                title: "Verified studio title",
                releaseDate: "2026-10-01T00:00:00Z",
                runLength: "00:15:00",
                models: [{ name: "Verified Person" }],
                categories: [{ name: "Anal" }],
                images: { poster: [{ src: "https://example.test/verified.jpg", width: 400 }] },
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    };
    await sync(store, providers, fetching)("initial");
    const scene = store.listAll()[0]!;
    assert.equal(scene.title, "Verified studio title");
    assert.equal(scene.thumbnailUrl, "https://example.test/verified.jpg");
    assert.deepEqual(scene.performers, ["Verified Person"]);
    assert.equal(scene.fieldProvenance.title, "studio-site");
    assert.ok(scene.provenance.some((item) => item.source === "studio-site"));
    assert.equal(
      store.listProviderObservations().find((item) => item.providerId === "traxxx")!.record
        .durationSec,
      600,
    );
    assert.deepEqual(scene.durationRange, { minSec: 601, maxSec: 900 });
  } finally {
    store.close();
  }
});

test("Maximo TPDB exclusions remove only the excluded provider observation", async () => {
  const store = database();
  try {
    let title = "Shared title";
    const fetching: Fetcher = {
      ...tpdbFetcher,
      json: async <T>(url: string) => {
        const result = await tpdbFetcher.json<{ data: { title?: string }[] }>(url);
        if (new globalThis.URL(url).pathname !== "/sites") result.data[0]!.title = title;
        return result as T;
      },
    };
    const fansly = source("maximo-garcia", () => [record("other", { studioId: "maximo-garcia" })]);
    const run = sync(store, [fansly, tpdb("maximo-garcia")], fetching);
    await run("initial");
    title = "A trans release";
    await run("excluded");
    assert.equal(store.listAll().length, 1);
    assert.deepEqual(
      store.listProviderObservations().map((item) => item.providerId),
      ["maximo-garcia"],
    );
    assert.equal(store.listAll()[0]!.title, "Shared title");
  } finally {
    store.close();
  }
});

test("a later higher-priority provider preserves the established canonical ID", async () => {
  const store = database();
  try {
    let available = false;
    const run = sync(store, [
      source("first", () => (available ? [record("one")] : [])),
      source("second", () => [record("two")]),
    ]);
    await run("initial");
    const id = store.listAll()[0]!.id;
    available = true;
    await run("joined");
    assert.equal(store.listAll().length, 1);
    assert.equal(store.listAll()[0]!.id, id);
  } finally {
    store.close();
  }
});
