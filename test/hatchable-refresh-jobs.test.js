import assert from "node:assert/strict";
import test from "node:test";
import { claimRefresh, currentRefresh, finishRefresh, queueRefresh } from "../lib/refresh-jobs.js";

function fixture() {
  let row = null;
  const db = {
    async query(sql, params = []) {
      if (sql.startsWith("INSERT INTO refresh_jobs")) {
        if (row && !["complete", "failed"].includes(row.status)) return { rows: [] };
        row = {
          run_id: params[0],
          status: "queued",
          reason: params[1],
          started_at: "2026-10-08T00:00:00.000Z",
          updated_at: "2026-10-08T00:00:00.000Z",
          summary: null,
        };
        return { rows: [row] };
      }
      if (sql.startsWith("SELECT run_id")) return { rows: row ? [row] : [] };
      if (sql.startsWith("UPDATE refresh_jobs SET status = 'running'")) {
        if (row?.run_id !== params[0] || row.status !== "queued") return { rows: [] };
        row.status = "running";
        return { rows: [{ run_id: row.run_id }] };
      }
      if (sql.startsWith("UPDATE refresh_jobs SET status = $1")) {
        if (row?.run_id === params[2]) {
          row.status = params[0];
          row.summary = params[1];
        }
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  };
  const scheduled = [];
  const scheduler = { at: async (...args) => scheduled.push(args) };
  return { db, scheduler, scheduled };
}

test("manual and hourly requests share one queued refresh and only one worker claims it", async () => {
  const { db, scheduler, scheduled } = fixture();
  const manual = await queueRefresh(db, scheduler, "manual");
  const hourly = await queueRefresh(db, scheduler, "hourly");
  assert.equal(manual.queued, true);
  assert.equal(hourly.queued, false);
  assert.equal(hourly.job.run_id, manual.job.run_id);
  assert.equal(scheduled.length, 1);
  assert.equal(await claimRefresh(db, manual.job.run_id), true);
  assert.equal(await claimRefresh(db, manual.job.run_id), false);
  await finishRefresh(db, manual.job.run_id, "complete");
  assert.equal((await currentRefresh(db)).status, "complete");
});

test("a completed refresh can be replaced by the next hourly run", async () => {
  const { db, scheduler } = fixture();
  const first = await queueRefresh(db, scheduler, "hourly");
  await finishRefresh(db, first.job.run_id, "failed", "safe summary");
  const second = await queueRefresh(db, scheduler, "hourly");
  assert.equal(second.queued, true);
  assert.notEqual(second.job.run_id, first.job.run_id);
});

test("refresh status only accepts terminal states", async () => {
  const { db } = fixture();
  await assert.rejects(finishRefresh(db, "run", "running"), /Invalid refresh status/);
});
