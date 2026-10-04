import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { makeScene } from "./helpers.ts";

const cli = new URL("../src/cli/uploader-discovery.ts", import.meta.url);
function run(args: string[], dbPath = ":memory:", preload?: string) {
  return spawnSync(
    process.execPath,
    [...(preload ? ["--import", preload] : []), cli.pathname, ...args],
    {
      env: { ...process.env, LISZT_DB_PATH: dbPath },
      encoding: "utf8",
      timeout: 10000,
    },
  );
}

test("discovery rejects invalid numeric options instead of defaulting or bypassing filters", () => {
  for (const name of ["limit", "per-scene", "window", "min-delta"]) {
    for (const value of [
      "NaN",
      "Infinity",
      "-1",
      "",
      " ",
      ...(name === "limit" || name === "per-scene" ? ["0"] : []),
    ]) {
      const result = run([`--${name}=${value}`]);
      assert.equal(result.status, 1, `${name}=${value}: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`--${name} must be a finite`));
    }
  }
  const result = run(["--window=0", "--min-delta=0", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).windowDays, 0);
  assert.equal(JSON.parse(result.stdout).minDeltaSec, 0);
});

test("discovery uses ManyVids creator metadata and fetches only canonical eporner pages", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-discovery-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "test.db");
  const requests = join(dir, "requests.jsonl");
  const hook = join(dir, "fetch.mjs");
  const date = new Date().toISOString().slice(0, 10);
  const store = new SqliteStore(dbPath);
  store.migrate();
  store.upsertScene(
    makeScene({
      id: "manyvids-1003095958:test",
      sourceId: "manyvids-1003095958",
      labelId: "different-label",
      label: "Registry Creator Label",
      title: "Example scene title",
      performers: ["Example Performer"],
      releaseDate: date,
    }),
  );
  store.close();
  // The preload replaces all network access; unexpected requests fail the assertions below.
  writeFileSync(
    hook,
    `
    import { appendFileSync } from "node:fs";
    globalThis.fetch = async (url) => {
      appendFileSync(${JSON.stringify(requests)}, JSON.stringify(url) + "\\n");
      if (new URL(url).pathname === "/api/v2/video/search/") {
        return Response.json({ videos: [
          { id: "ignored", url: "https://untrusted.invalid/video-abc/", title: "Example Performer", length_sec: 600, added: ${JSON.stringify(date)}, views: "1,234" },
          { id: "def", title: "Example Performer", length_sec: 600, added: ${JSON.stringify(date)}, views: " , " }
        ] });
      }
      return new Response('<li class="vit-uploader"><a href="/profile/ExampleUploader/">ExampleUploader</a></li>');
    };
  `,
  );
  const result = run(["--json"], dbPath, pathToFileURL(hook).href);
  assert.equal(result.status, 0, result.stderr);
  const urls = readFileSync(requests, "utf8")
    .trim()
    .split("\n")
    .map((line) => new URL(JSON.parse(line)));
  const queries = urls
    .filter((url) => url.pathname === "/api/v2/video/search/")
    .map((url) => url.searchParams.get("query"));
  assert.ok(queries.includes("example performer"));
  assert.ok(
    !queries.includes("Registry Creator Label"),
    "creator metadata is keyed by source, not label",
  );
  assert.deepEqual(
    urls.filter((url) => url.pathname !== "/api/v2/video/search/").map((url) => url.href),
    ["https://www.eporner.com/video-abc/", "https://www.eporner.com/video-def/"],
  );
  const report = JSON.parse(result.stdout);
  assert.equal(report.observations, 2);
  assert.equal(report.proposals[0].totalViews, 1234);
});
