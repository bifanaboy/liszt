import { test } from "node:test";
import assert from "node:assert/strict";
import { createSync, normaliseScene } from "../src/pipeline/sync.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { NullLogger } from "../src/core/logger.ts";
import { fixedClock } from "../src/sources/types.ts";
import type { RawScene, SourceAdapter, SourceResult } from "../src/sources/types.ts";

const NOW = "2026-03-10T00:00:00Z";
const RELEASE = "https://darkkotv.com/scenes/lana-analise-gaping-interracial-anal_vids.html";

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

function adapter(id: string, scenes: () => RawScene[]): SourceAdapter {
  return {
    id,
    name: id,
    authority: { name: "test", url: `https://example.test/${id}`, role: "catalogue source" },
    matcher: "sxyprn+eporner",
    fetch: async (): Promise<SourceResult> => ({ scenes: scenes(), verifiedEmpty: false }),
  };
}

function buildSync(store: SqliteStore, sources: SourceAdapter[]) {
  return createSync({
    store,
    sources,
    retiredSourceIds: [],
    fetcher: {
      fetch: async () => new Response(""),
      text: async () => "",
      json: async <T>() => ({}) as T,
    },
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { poolLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
  });
}

test("one release described by two lanes is stored once", async () => {
  // The Traxxx studio lane and the TPDB lane both cover the same studio and both
  // emit the studio's own release page. Before the cross-lane dedup this stored
  // the release twice and the catalogue showed it twice.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    const sync = buildSync(store, [
      adapter("channel-darkkotv-anal", () => [
        raw("1", {
          studioId: "channel-darkkotv-anal",
          releaseUrl: RELEASE,
          thumbnailUrl: "",
          fieldProvenance: { title: "channel-darkkotv-anal" },
        }),
      ]),
      adapter("tpdb-watchlist", () => [
        raw("e265ca40-3ed9-4307-b583-e1a50f2346d0", {
          studioId: "channel-darkkotv-anal",
          releaseUrl: RELEASE.toUpperCase(),
          thumbnailUrl: "https://img.test/scene.jpg",
          fieldProvenance: { thumbnailUrl: "TPDB" },
        }),
      ]),
    ]);
    await sync("first");
    const stored = store.listAll();
    assert.equal(stored.length, 1, "the release is stored once");
    assert.equal(store.listProviderObservations(stored[0]!.id).length, 2);
    assert.equal(stored[0]?.thumbnailUrl, "https://img.test/scene.jpg");
    assert.equal(stored[0]?.fieldProvenance.thumbnailUrl, "tpdb-watchlist");
    assert.equal(stored[0]?.provenance.length, 2);
    assert.equal(stored[0]?.sourceId, "channel-darkkotv-anal");
    await sync("second");
    const refreshed = store.listAll();
    assert.equal(refreshed.length, 1);
    assert.equal(refreshed[0]?.id, stored[0]?.id);
    assert.equal(refreshed[0]?.sourceId, stored[0]?.sourceId);
    assert.equal(refreshed[0]?.source, stored[0]?.source);
  } finally {
    store.close();
  }
});

test("punctuation variants update one canonical release", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    await buildSync(store, [
      adapter("provider-a", () => [
        raw("first", {
          studioId: "studio",
          releaseUrl: "https://www.letsdoeit.com/scene/11521133/balls-deep-in-ex-s-big-ass",
        }),
      ]),
      adapter("provider-b", () => [
        raw("second", {
          studioId: "studio",
          releaseUrl: "https://www.letsdoeit.com/scene/11521133/balls-deep-in-exs-big-ass",
        }),
      ]),
    ])("first");
    assert.equal(store.listAll().length, 1);
    assert.equal(store.listProviderObservations().length, 2);
  } finally {
    store.close();
  }
});

test("similar titles on different hosts do not merge", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    await buildSync(store, [
      adapter("provider-a", () => [
        raw("first", {
          studioId: "studio",
          title: "Curvy Tommy King’s Anal Fuck",
          releaseDate: "2026-03-01",
          releaseUrl: "https://www.analvids.com/watch/4996438/curvy-tommy-king",
        }),
      ]),
      adapter("provider-b", () => [
        raw("second", {
          studioId: "studio",
          title: "Curvy Tommy Kings Anal Fuck",
          releaseDate: "2026-03-01",
          releaseUrl: "https://www.sexlikereal.com/scenes/curvy-tommy-kings-93382",
        }),
      ]),
    ])("first");
    assert.equal(store.listAll().length, 2);
  } finally {
    store.close();
  }
});

test("Maximo cross-provider records merge by normalized title and keep the oldest release date", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    await buildSync(store, [
      adapter("maximo-garcia", () => [
        raw("fansly-1", {
          studioId: "maximo-garcia",
          studio: "Maximo Garcia",
          title: "A Shared Release!",
          releaseDate: "2026-03-05",
          durationSec: 600,
          releaseUrl: "https://fansly.com/maximo_garcia/post/1",
        }),
      ]),
      adapter("tpdb-watchlist", () => [
        raw("mv-1", {
          providerId: "tpdb-site-7875",
          studioId: "tpdb-maximogarcia",
          studio: "Maximo Garcia",
          title: "A Shared-Release",
          releaseDate: "2026-03-04",
          durationSec: 600,
          releaseUrl: "https://www.maximogarcia.com/scene/1/shared-release/",
        }),
      ]),
    ])("first");
    assert.equal(store.listAll().length, 1);
    assert.equal(store.listProviderObservations().length, 2);
    assert.equal(store.listAll()[0]?.releaseDate, "2026-03-04");
  } finally {
    store.close();
  }
});

test("Maximo duration disagreements are retained as a reviewable range", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    await buildSync(store, [
      adapter("maximo-garcia", () => [
        raw("fansly-1", {
          studioId: "maximo-garcia",
          title: "A Shared Release",
          releaseDate: "2026-03-05",
          durationSec: 600,
        }),
      ]),
      adapter("tpdb-watchlist", () => [
        raw("mv-1", {
          providerId: "tpdb-site-7875",
          studioId: "tpdb-maximogarcia",
          title: "A Shared Release",
          releaseDate: "2026-03-04",
          durationSec: 602,
        }),
      ]),
    ])("first");
    const scene = store.listAll()[0]!;
    assert.equal(store.listAll().length, 1);
    assert.equal(scene.durationSec, null);
    assert.deepEqual(scene.durationRange, { minSec: 600, maxSec: 602 });
    assert.equal(scene.durationReview, true);
  } finally {
    store.close();
  }
});

test("a scene still updates itself on later syncs", async () => {
  // The dedup is seeded from stored rows, so a naive "already seen" check would
  // make every scene suppress itself and freeze the catalogue at its first
  // write. The stored row must not be treated as a duplicate of itself.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    let title = "First title";
    const source = adapter("channel-darkkotv-anal", () => [
      raw("1", { studioId: "channel-darkkotv-anal", releaseUrl: RELEASE, title }),
    ]);
    const sync = buildSync(store, [source]);
    await sync("first");
    assert.equal(store.getScene("channel-darkkotv-anal:1")?.title, "First title");
    title = "Corrected title";
    await sync("second");
    assert.equal(
      store.getScene("channel-darkkotv-anal:1")?.title,
      "Corrected title",
      "the update lands",
    );
    assert.equal(store.listAll().length, 1);
  } finally {
    store.close();
  }
});

test("a later provider joins the existing canonical release without changing its ID", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    let present = false;
    const first = adapter("provider-a", () => [
      raw("first", { studioId: "studio", releaseUrl: RELEASE, title: "Original title" }),
    ]);
    const second = adapter("provider-b", () =>
      present
        ? [
            raw("second", {
              studioId: "studio",
              releaseUrl: RELEASE,
              title: "Corrected title",
              thumbnailUrl: "https://img.test/poster.jpg",
            }),
          ]
        : [],
    );
    const sync = buildSync(store, [first, second]);
    await sync("first");
    const id = store.listAll()[0]?.id;
    present = true;
    await sync("second");

    assert.equal(store.listAll().length, 1);
    assert.equal(store.listAll()[0]?.id, id);
    assert.equal(store.listAll()[0]?.title, "Original title");
    assert.equal(store.listAll()[0]?.thumbnailUrl, "https://img.test/poster.jpg");
    assert.equal(store.listProviderObservations(id).length, 2);
  } finally {
    store.close();
  }
});

test("a release with no URL is kept rather than dropped", async () => {
  // Two records without a URL cannot be proven to be the same release, and
  // discarding a real release is far worse than showing one twice.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    await buildSync(store, [
      adapter("lane-a", () => [raw("1"), raw("2")]),
      adapter("lane-b", () => [raw("3")]),
    ])("first");
    assert.equal(store.listAll().length, 3);
  } finally {
    store.close();
  }
});

test("an excluded stored scene releases its claim, so another lane's record survives", async () => {
  // The claim map is seeded from stored rows, so an excluded scene that kept its
  // claim would suppress the second lane's record for the same release - and the
  // exclusion then deletes the stored row, leaving the release absent until a
  // later sync happened to re-import it.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    const excluding = adapter("lane-a", () => []);
    // A plain lane, so the stored id is exactly `lane-a:1` - the same shape
    // `deleteSourceScenes` deletes by.
    store.upsertScene(
      normaliseScene(
        adapter("lane-a", () => []),
        raw("1", { releaseUrl: RELEASE }),
        new Date(NOW),
        undefined,
        null,
      ),
    );
    excluding.fetch = async (): Promise<SourceResult> => ({
      scenes: [],
      // A lane returning nothing MUST assert it is genuinely empty, or the sync
      // treats it as a parser failure and the lane never reaches the dedup.
      verifiedEmpty: true,
      excludedSceneIds: ["1"],
    });
    await buildSync(store, [
      excluding,
      adapter("lane-b", () => [raw("other", { releaseUrl: RELEASE })]),
    ])("first");
    const rows = store.listAll();
    assert.equal(rows.length, 1, "the release is still present, filed under the surviving lane");
    assert.equal(rows[0]?.id, "lane-b:other");
  } finally {
    store.close();
  }
});

test("two different releases from one lane are not collapsed into each other", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    const source = adapter("lane", () => [
      raw("1", { releaseUrl: "https://x.test/one" }),
      raw("2", { releaseUrl: "https://x.test/two" }),
    ]);
    store.upsertScene(
      normaliseScene(
        source,
        raw("1", { releaseUrl: "https://x.test/one" }),
        new Date(NOW),
        undefined,
        null,
      ),
    );
    await buildSync(store, [source])("first");
    assert.equal(store.listAll().length, 2);
  } finally {
    store.close();
  }
});
