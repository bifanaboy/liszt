import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store/sqlite.ts";

const migrations = new URL("../src/core/store/migrations/", import.meta.url);

function tableNames(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string;
    }[]
  ).map((row) => row.name);
}

test("fresh catalogues omit the retired Eporner uploader index", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.migrate();
    store.migrate();
    const db = (store as unknown as { db: DatabaseSync }).db;
    assert.equal(tableNames(db).includes("pool_videos"), false);
    assert.equal(tableNames(db).includes("pool_meta"), false);
    assert.deepEqual(
      (
        db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as {
          version: number;
        }[]
      ).map((row) => row.version),
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  } finally {
    store.close();
  }
});

test("migration 12 removes an existing uploader index while preserving catalogue data", () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-drop-pool-migration-"));
  const path = join(dir, "catalogue.db");
  const db = new DatabaseSync(path);
  try {
    for (const [index, file] of [
      "0001_init.sql",
      "0002_drop_sessions.sql",
      "0003_pool_video_views.sql",
      "0004_run_resolver_health.sql",
      "0005_pool_hydration_attempt.sql",
      "0006_pool_undated_scan.sql",
      "0007_manyvids.sql",
      "0008_fc2_candidates.sql",
      "0009_studio_metadata.sql",
      "0010_provider_observations.sql",
      "0011_link_parts.sql",
    ].entries()) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
      );
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(index + 1, "original");
    }
    db.exec(`INSERT INTO runs (id, started_at) VALUES ('existing', '2026-10-01T00:00:00Z');
      INSERT INTO pool_videos (id, uploader, title, views) VALUES ('video', 'account', 'Existing video', 42);`);
  } finally {
    db.close();
  }

  const store = new SqliteStore(path);
  try {
    store.migrate();
    assert.equal(store.recentRuns(1)[0]?.id, "existing");
    const upgraded = (store as unknown as { db: DatabaseSync }).db;
    assert.equal(tableNames(upgraded).includes("pool_videos"), false);
    assert.equal(tableNames(upgraded).includes("pool_meta"), false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
