import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("Traxxx-only declaration works without a TPDB key", () => {
  const result = spawnSync(
    process.execPath,
    [
      "src/cli/link-studios.ts",
      "--name",
      "Demo Studio",
      "https://traxxx.me/network/demo/scenes/latest/1?tags=anal",
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, TPDB_API_KEY: "" },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Demo Studio/);
  assert.match(result.stdout, /network-demo-anal/);
  assert.doesNotMatch(result.stdout, /TPDB_API_KEY/);
});
