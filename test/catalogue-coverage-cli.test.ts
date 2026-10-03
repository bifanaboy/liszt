import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { makeScene } from "./helpers.ts";

const cli = new URL("../src/cli/catalogue-coverage.ts", import.meta.url).pathname;
test("coverage command compares all four normalized exports", () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-coverage-"));
  try {
    const args: string[] = [];
    for (const provider of ["tpdb", "stashdb", "traxxx", "manyvids"]) {
      const path = join(dir, `${provider}.json`);
      writeFileSync(
        path,
        JSON.stringify([
          { id: provider, title: "Shared release", releaseDate: "2026-09-04", durationSec: 2954 },
        ]),
      );
      args.push(`--${provider}`, path);
    }
    const report = JSON.parse(execFileSync(process.execPath, [cli, ...args], { encoding: "utf8" }));
    assert.equal(report.unionCount, 1);
    assert.ok(
      Object.values(report.providers).every(
        (p: unknown) => (p as { coverage: number }).coverage === 1,
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("coverage command identifies both local providers and marks absent databases unavailable", () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-coverage-"));
  const path = join(dir, "catalogue.db");
  const store = new SqliteStore(path);
  try {
    store.migrate();
    for (const [sourceId, authorityName] of [
      ["manyvids-1003095958", "ManyVids"],
      ["tushy", "traxxx.me"],
    ]) {
      store.upsertSource({
        sourceId: sourceId!,
        labelId: sourceId!,
        authority: { name: authorityName!, url: "https://example.test", role: "test" },
      });
      store.upsertScene(
        makeScene({
          id: `${sourceId}:1`,
          sourceId: sourceId!,
          releaseDate: new Date().toISOString().slice(0, 10),
          title: "Shared release",
        }),
      );
    }
    const report = JSON.parse(
      execFileSync(process.execPath, [cli], {
        encoding: "utf8",
        env: { ...process.env, LISZT_DB_PATH: path },
      }),
    );
    assert.equal(report.unionCount, 1);
    assert.equal(report.providers.manyvids.coverage, 1);
    assert.equal(report.providers.traxxx.coverage, 1);
    assert.equal(report.providers.tpdb.available, false);
    assert.equal(report.providers.stashdb.available, false);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
