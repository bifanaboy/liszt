import { db } from "hatchable";
import { currentRefresh } from "lib/refresh-jobs.js";

export const methods = ["GET"];
export const access = "member";

export default async function (_req, res) {
  const job = await currentRefresh(db);
  const active = ["queued", "running"].includes(job?.status);
  res.json({
    generatedAt: new Date().toISOString(),
    progress: {
      active,
      runId: job?.runId ?? null,
      startedAt: job?.startedAt ?? null,
      stage: job?.status === "failed" ? "error" : active ? "populating" : "idle",
      index: { done: 0, total: 0, current: "" },
      populate: { done: 0, total: 0, current: [] },
      link: { done: 0, total: 0, matched: 0, substage: "resolve", verifyDone: 0, verifyTotal: 0 },
    },
  });
}
