import { db, scheduler } from "hatchable";
import { queueRefresh } from "lib/refresh-jobs.js";

export const methods = ["POST"];
export const access = "scheduler";

export default async function (_req, res) {
  const result = await queueRefresh(db, scheduler, "hourly");
  res.json({ queued: result.queued, status: result.job?.status ?? "unknown" });
}
