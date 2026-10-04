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
    await buildSync(store, [
      adapter("channel-darkkotv-anal", () => [
        raw("1", { studioId: "channel-darkkotv-anal", releaseUrl: RELEASE }),
      ]),
      adapter("tpdb-watchlist", () => [
        raw("e265ca40-3ed9-4307-b583-e1a50f2346d0", {
          studioId: "channel-darkkotv-anal",
          releaseUrl: RELEASE.toUpperCase(),
        }),
      ]),
    ])("first");
    assert.equal(store.listAll().length, 1, "the release is stored once");
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
