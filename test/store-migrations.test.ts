import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { SqliteStore } from "../src/core/store/sqlite.ts";

const migrations = new URL("../src/core/store/migrations/", import.meta.url);

test("two processes starting migrations together both finish successfully", async () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-migrations-concurrent-"));
  const path = join(dir, "catalogue.db");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode = WAL;");
    for (const [index, file] of [
      "0001_init.sql",
      "0002_drop_sessions.sql",
      "0003_pool_video_views.sql",
    ].entries()) {
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(index + 1, "original");
    }
    // The collision could leave only this update committed at version 4.
    db.exec("ALTER TABLE pool_videos ADD COLUMN hydration_attempted_at TEXT;");
    db.prepare("INSERT INTO schema_migrations VALUES (4, ?)").run("original");
  } finally {
    db.close();
  }
  const barrier = new SharedArrayBuffer(4);
  const workers: Worker[] = [];
  try {
    await Promise.all(
      Array.from(
        { length: 2 },
        () =>
          new Promise<void>((resolve, reject) => {
            const worker = new Worker(
              `
          const { workerData } = require('node:worker_threads');
          const { DatabaseSync } = require('node:sqlite');
          const originalExec = DatabaseSync.prototype.exec;
          let firstLock = true;
          DatabaseSync.prototype.exec = function(sql) {
            if (sql === 'BEGIN IMMEDIATE' && firstLock) {
              firstLock = false;
              const arrivals = new Int32Array(workerData.barrier);
              Atomics.add(arrivals, 0, 1);
              Atomics.notify(arrivals, 0);
              while (Atomics.load(arrivals, 0) < 2) {
                if (Atomics.wait(arrivals, 0, 1, 10000) === 'timed-out') {
                  throw new Error('second migration worker did not reach its first lock');
                }
              }
            }
            return originalExec.call(this, sql);
          };
          (async () => {
            const { SqliteStore } = await import(workerData.storeUrl);
            const store = new SqliteStore(workerData.path);
            try { store.migrate(); } finally { store.close(); }
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
              {
                eval: true,
                workerData: {
                  path,
                  barrier,
                  storeUrl: new URL("../src/core/store/sqlite.ts", import.meta.url).href,
                },
              },
            );
            workers.push(worker);
            worker.on("error", reject);
            worker.on("exit", (code) =>
              code === 0 ? resolve() : reject(new Error(`migration worker exited ${code}`)),
            );
          }),
      ),
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fresh catalogue applies both database updates and can migrate again", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.migrate();
    store.migrate();
    store.recordRun({
      id: "fresh",
      kind: "sync",
      startedAt: "2026-10-02T00:00:00Z",
      endedAt: null,
      outcomes: [],
      ok: null,
      error: null,
      resolverHealth: { errored: 2 },
    });
    assert.deepEqual(store.recentRuns(1)[0]?.resolverHealth, { errored: 2 });
    store.upsertPoolVideo({
      id: "video",
      uploader: "account",
      title: "Existing video",
      added: null,
      durationSec: 600,
      hydratedAt: null,
      views: 42,
    });
    store.markPoolHydrationAttempt("video", "account", "2026-10-02T00:00:00Z");
    assert.equal(
      store.poolVideosForUploader("account")[0]?.hydrationAttemptedAt,
      "2026-10-02T00:00:00Z",
    );
  } finally {
    store.close();
  }
});

for (const previous of ["version 3", "resolver version 4", "pool version 4"] as const) {
  test(`upgrading ${previous} preserves rows and supports both updates after reopening`, () => {
    const dir = mkdtempSync(join(tmpdir(), "liszt-migrations-"));
    const path = join(dir, "catalogue.db");
    const db = new DatabaseSync(path);
    try {
      for (const [index, file] of [
        "0001_init.sql",
        "0002_drop_sessions.sql",
        "0003_pool_video_views.sql",
      ].entries()) {
        db.exec(readFileSync(new URL(file, migrations), "utf8"));
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(index + 1, "original");
      }
      db.exec(`INSERT INTO runs (id, started_at) VALUES ('existing', '2026-10-01T00:00:00Z');
        INSERT INTO pool_videos (id, uploader, title, views) VALUES ('video', 'account', 'Existing video', 42);`);
      if (previous === "resolver version 4") {
        db.exec("ALTER TABLE runs ADD COLUMN resolver_health TEXT;");
        db.exec(`UPDATE runs SET resolver_health = '{"errored":2}';`);
      } else if (previous === "pool version 4") {
        db.exec("ALTER TABLE pool_videos ADD COLUMN hydration_attempted_at TEXT;");
        db.exec("UPDATE pool_videos SET hydration_attempted_at = '2026-10-01T00:00:00Z';");
      }
      if (previous !== "version 3") {
        db.prepare("INSERT INTO schema_migrations VALUES (4, ?)").run("original");
      }
    } finally {
      db.close();
    }
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const store = new SqliteStore(path);
        try {
          store.migrate();
          assert.equal(store.recentRuns(1)[0]?.id, "existing");
          assert.deepEqual(
            store.recentRuns(1)[0]?.resolverHealth,
            previous === "resolver version 4" ? { errored: 2 } : null,
          );
          const video = store.poolVideosForUploader("account")[0];
          assert.equal(video?.title, "Existing video");
          assert.equal(video?.views, 42);
          assert.equal(
            video?.hydrationAttemptedAt,
            previous === "pool version 4" ? "2026-10-01T00:00:00Z" : null,
          );
        } finally {
          store.close();
        }
      }
      const upgraded = new DatabaseSync(path);
      try {
        assert.deepEqual(
          upgraded
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .all()
            .map((row) => row.version),
          [1, 2, 3, 4, 5, 6, 7, 8, 9],
        );
        assert.equal(
          upgraded
            .prepare("SELECT applied_at FROM schema_migrations WHERE version = ?")
            .get(previous === "pool version 4" ? 5 : 3)?.applied_at,
          "original",
        );
      } finally {
        upgraded.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("scan progress upgrades hydration history and persists separately across reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-scan-migration-"));
  const path = join(dir, "catalogue.db");
  const attemptedAt = "2026-10-01T00:00:00Z";
  try {
    const db = new DatabaseSync(path);
    try {
      for (const [index, file] of [
        "0001_init.sql",
        "0002_drop_sessions.sql",
        "0003_pool_video_views.sql",
        "0004_run_resolver_health.sql",
        "0005_pool_hydration_attempt.sql",
      ].entries()) {
        db.exec(readFileSync(new URL(file, migrations), "utf8"));
        db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(index + 1, "original");
      }
      db.prepare(
        "INSERT INTO pool_videos (id, uploader, hydration_attempted_at) VALUES (?, ?, ?)",
      ).run("attempted", "account", attemptedAt);
      db.exec("INSERT INTO pool_videos (id, uploader) VALUES ('untouched', 'account');");
    } finally {
      db.close();
    }
    const store = new SqliteStore(path);
    try {
      store.migrate();
      assert.deepEqual(
        store.poolVideosUndated("account", 1).map((row) => row.id),
        ["untouched"],
        "upgrade preserves existing hydration rotation",
      );
      store.markPoolUndatedScan("untouched", "account", "2026-10-02T00:00:00Z");
      store.markPoolUndatedScan("attempted", "account", "2026-10-03T00:00:00Z");
    } finally {
      store.close();
    }
    const reopened = new SqliteStore(path);
    try {
      reopened.migrate();
      const rows = reopened.poolVideosUndated("account");
      assert.deepEqual(
        rows.map((row) => row.id),
        ["untouched", "attempted"],
      );
      assert.equal(rows[0]?.hydrationAttemptedAt, null);
      assert.equal(rows[1]?.hydrationAttemptedAt, attemptedAt);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upgrading current main adds FC2 state without skipping the ManyVids migration", () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-fc2-upgrade-"));
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
    ].entries()) {
      db.exec(readFileSync(new URL(file, migrations), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(index + 1, "original");
    }
  } finally {
    db.close();
  }
  const store = new SqliteStore(path);
  try {
    store.migrate();
    store.noteFc2Sightings(
      [{ videoId: "4979341", releaseDate: "2026-09-22" }],
      "2026-10-03T00:00:00Z",
    );
    assert.equal(store.fc2Candidate("4979341")?.status, "pending");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
