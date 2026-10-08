import { db } from "hatchable";
import { claimRefresh, currentRefresh, finishRefresh } from "lib/refresh-jobs.js";
import { runRefreshCycle } from "lib/refresh.js";

export const methods = ["POST"];
export const access = "scheduler";

export default async function (req, res) {
  const runId = req.body?.runId;
  if (typeof runId !== "string" || !/^sync-[a-f0-9-]{36}$/.test(runId)) {
    res.status(400).json({ ok: false, error: "Invalid refresh job" });
    return;
  }
  if (!(await claimRefresh(db, runId))) {
    res.json({ ok: true, status: "already claimed" });
    return;
  }

  try {
    const job = await currentRefresh(db);
    await runRefreshCycle(db, job?.reason ?? "scheduled");
    await finishRefresh(db, runId, "complete");
    res.json({ ok: true, status: "complete", runId });
  } catch {
    await finishRefresh(db, runId, "failed", "Refresh failed; inspect Hatchable function logs.");
    throw new Error("Refresh failed; inspect Hatchable function logs.");
  }
}
