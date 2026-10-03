import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store/sqlite.ts";

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
