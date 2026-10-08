/**
 * Which rung failed, counted on its own.
 *
 * `logRungFailure` kept ONE counter for the whole ladder, so the throttled log
 * lines carried a `seenSoFar` that grew across both tubes. A run where sxyprn
 * timed out on 110 scenes and the pool errored on a handful was reported as a
 * single running total, which is what let this rung be described as dead on the
 * strength of an aggregate. The count has to belong to the rung.
 *
 * Its own file because the counters are module state, and `node --test` gives
 * every file a fresh process. Sharing a file with the ladder suite would make
 * the expected numbers depend on which tests ran first.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScene } from "../lib/tubes/resolve.js";
import { makeScene } from "./helpers.ts";
/** Resolve one scene with both rungs failing, and collect what the log was told. */
async function runFailures(scenes) {
  const lines = [];
  for (let index = 0; index < scenes; index += 1) {
    await resolveScene(makeScene({ id: `test:${index}`, durationSec: 600 }), {
      matcher: "duration+date",
      creatorStudio: false,
      now: new Date("2026-03-10T00:00:00Z"),
      poolLookup: async () => {
        throw new Error("pool offline");
      },
      sxyprnLookup: async () => {
        throw new Error("sxyprn search timed out after 15000ms");
      },
      log: {
        warn: (message, fields = {}) => {
          if (message !== "ladder rung failed") return;
          lines.push({
            rung: String(fields.rung),
            error: String(fields.error),
            seenSoFar: Number(fields.seenSoFar),
          });
        },
      },
    });
  }
  return lines;
}
test("each rung counts its own failures", async () => {
  const lines = await runFailures(25);
  const pool = lines.filter((line) => line.rung === "eporner-pool");
  const sxyprn = lines.filter((line) => line.rung === "sxyprn");
  // Throttled to the first failure and then every tenth, per rung.
  assert.deepEqual(
    pool.map((line) => line.seenSoFar),
    [1, 11, 21],
  );
  assert.deepEqual(
    sxyprn.map((line) => line.seenSoFar),
    [1, 11, 21],
  );
  // And the rung is named with its own reason, so a timeout is not filed under
  // the pool's outage.
  assert.ok(sxyprn.every((line) => /timed out after 15000ms/.test(line.error)));
  assert.ok(pool.every((line) => /pool offline/.test(line.error)));
});
