import { db, scheduler } from "hatchable";
import { queueRefresh } from "lib/refresh-jobs.js";

export const methods = ["POST"];
export const access = "member";

export default async function (_req, res) {
  try {
    const result = await queueRefresh(db, scheduler, "manual");
    res.status(result.queued ? 202 : 200).json({
      ok: true,
      status: result.queued ? "started" : (result.job?.status ?? "unknown"),
      runId: result.job?.run_id ?? null,
      refreshing: result.queued || ["queued", "running"].includes(result.job?.status),
    });
  } catch {
    res.status(503).json({ ok: false, error: "Unable to schedule refresh" });
  }
}
