import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReadModel } from "../src/serving/read-model.ts";
import { loadConfig } from "../src/config.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import type { Scene } from "../src/core/schema.ts";

function record(id: string, overrides: Record<string, unknown> = {}): Scene {
  return {
    id,
    sourceId: "provider-a",
    source: "Provider A",
    labelId: "studio",
    label: "Studio",
    title: "Shared title",
    performers: ["Alex"],
    releaseDate: "2026-10-03",
    durationSec: 600,
    thumbnailUrl: "",
    tags: [],
    provenance: [
      { source: "provider-a", fetchedAt: "2026-10-04T00:00:00Z" },
      { source: "provider-b", fetchedAt: "2026-10-04T00:00:00Z" },
    ],
    fieldProvenance: { title: "provider-a", durationSec: "provider-b" },
    metadataPoor: false,
    studioMetadataCheckedAt: null,
    videoUrls: [],
    deadVideoUrls: [],
    videoCheckedAt: null,
    videoMatching: null,
    ...overrides,
  } as Scene;
}

test("read model returns canonical field provenance without a second merge", () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    store.upsertScene(record("canonical"));
    const model = buildReadModel(store, loadConfig({}), new Date("2026-10-05T00:00:00Z"));

    assert.equal(model.scenes.length, 1);
    assert.equal(model.scenes[0]?.id, "canonical");
    assert.deepEqual(
      model.scenes[0]?.provenance.map((item) => item.source),
      ["provider-a", "provider-b"],
    );
    assert.equal(model.scenes[0]?.fieldProvenance.durationSec, "provider-b");
  } finally {
    store.close();
  }
});

test("read model keeps similar releases on different hosts separate", () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    store.upsertScene(
      record("first", {
        releaseUrl: "https://www.analvids.com/watch/4996438/curvy-tommy-king",
      }),
    );
    store.upsertScene(
      record("second", {
        releaseUrl: "https://www.sexlikereal.com/scenes/curvy-tommy-kings-93382",
      }),
    );
    const model = buildReadModel(store, loadConfig({}), new Date("2026-10-05T00:00:00Z"));

    assert.equal(model.scenes.length, 2);
    assert.deepEqual(model.scenes.map((scene) => scene.id).sort(), ["first", "second"]);
  } finally {
    store.close();
  }
});
