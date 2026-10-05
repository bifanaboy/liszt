import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { Scene } from "../src/core/schema.ts";
import type { ProviderObservation } from "../src/sources/types.ts";

test("fresh database applies both updates numbered 4 and can reopen", () => {
  const store = new SqliteStore(":memory:");
  try {
    assert.doesNotThrow(() => store.migrate());
    assert.doesNotThrow(() => store.migrate());
    assert.deepEqual(store.recentRuns(10), []);
  } finally {
    store.close();
  }
});

for (const existing of ["pool", "runs"]) {
  test(`upgrade repairs the other version 4 update when only ${existing} was applied`, () => {
    const dir = mkdtempSync(join(tmpdir(), "liszt-migration-"));
    const path = join(dir, "old.db");
    const db = new DatabaseSync(path);
    for (const file of ["0001_init.sql", "0002_drop_sessions.sql", "0003_pool_video_views.sql"]) {
      db.exec(
        readFileSync(new URL(`../src/core/store/migrations/${file}`, import.meta.url), "utf8"),
      );
    }
    db.exec(
      existing === "pool"
        ? "ALTER TABLE pool_videos ADD COLUMN hydration_attempted_at TEXT"
        : "ALTER TABLE runs ADD COLUMN resolver_health TEXT",
    );
    db.exec("INSERT INTO schema_migrations VALUES (1, 'old'), (2, 'old'), (3, 'old'), (4, 'old')");
    db.close();
    const store = new SqliteStore(path);
    try {
      store.migrate();
      const check = new DatabaseSync(path);
      try {
        assert.doesNotThrow(() =>
          check.prepare("SELECT hydration_attempted_at FROM pool_videos").all(),
        );
        assert.doesNotThrow(() => check.prepare("SELECT resolver_health FROM runs").all());
      } finally {
        check.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("observation migration preserves release IDs, playback history, and last-good records", () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-observation-migration-"));
  const path = join(dir, "old.db");
  const db = new DatabaseSync(path);
  const files = readdirSync(new URL("../src/core/store/migrations/", import.meta.url))
    .filter((file) => /^000[1-9]_.*\.sql$/.test(file))
    .sort();
  for (const file of files) {
    db.exec(readFileSync(new URL(`../src/core/store/migrations/${file}`, import.meta.url), "utf8"));
    const version = Number(file.slice(0, 4));
    if (version === 1) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
    }
    db.prepare("INSERT INTO schema_migrations VALUES (?, 'old')").run(version);
  }
  db.close();

  const legacy = new SqliteStore(path);
  const id = "bang-originals:scene-1";
  legacy.upsertScene(
    Scene.parse({
      id,
      sourceId: "bang-originals",
      source: "Bang! Originals",
      labelId: "bang-originals",
      label: "Bang! Originals",
      title: "Existing release",
      releaseDate: "2026-10-02",
      durationSec: 1200,
      performers: ["Alex"],
      thumbnailUrl: "https://bang.test/poster.jpg",
      releaseUrl: "https://bang.test/video/1",
      provenance: [
        {
          source: "Bang! Originals",
          fetchedAt: "2026-10-02T00:00:00.000Z",
          sourceSceneId: "scene-1",
          recordUrl: "https://bang.test/video/1",
        },
      ],
      fieldProvenance: { title: "bang-originals" },
      videoUrls: [
        {
          source: "eporner",
          url: "https://tube.test/live",
          verifiedAt: "2026-10-03T00:00:00.000Z",
        },
      ],
      deadVideoUrls: [
        {
          source: "sxyprn",
          url: "https://tube.test/dead",
          deadAt: "2026-10-03T00:00:00.000Z",
          deadReason: "not found",
        },
      ],
      videoCheckedAt: "2026-10-03T00:00:00.000Z",
      videoMatching: {
        lane: "trusted-pool",
        matchedAt: "2026-10-03T00:00:00.000Z",
        rule: "identity",
        confidence: "high",
      },
    }),
  );
  legacy.close();

  const upgraded = new SqliteStore(path);
  try {
    upgraded.migrate();
    const stored = upgraded.getScene(id);
    assert.equal(stored?.id, id);
    assert.equal(stored?.videoUrls[0]?.url, "https://tube.test/live");
    assert.equal(stored?.deadVideoUrls[0]?.url, "https://tube.test/dead");
    assert.equal(stored?.videoCheckedAt, "2026-10-03T00:00:00.000Z");
    assert.equal(stored?.videoMatching?.lane, "trusted-pool");
    const observation = upgraded.listProviderObservations(id)[0];
    assert.equal(observation?.providerId, "bang-originals");
    assert.equal(observation?.recordId, "scene-1");
    assert.equal(observation?.sceneId, id);
    const updated: ProviderObservation = {
      providerId: "bang-originals",
      recordId: "scene-1",
      sceneId: id,
      studioId: "bang-originals",
      studio: "Bang! Originals",
      fetchedAt: "2026-10-04T00:00:00.000Z",
      record: {
        sourceSceneId: "scene-1",
        title: "Corrected release",
        releaseDate: "2026-10-02",
        performers: [],
        durationSec: null,
        thumbnailUrl: "",
      },
    };
    upgraded.upsertProviderObservation(updated);
    assert.equal(upgraded.listProviderObservations(id).length, 1);
    assert.equal(upgraded.listProviderObservations(id)[0]?.record.title, "Corrected release");
    assert.deepEqual(upgraded.listProviderObservations(id)[0]?.record.performers, ["Alex"]);
    assert.equal(upgraded.listProviderObservations(id)[0]?.record.durationSec, 1200);
  } finally {
    upgraded.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
