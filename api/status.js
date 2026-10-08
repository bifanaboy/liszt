import { db } from "hatchable";
import { currentRefresh } from "lib/refresh-jobs.js";
import { createStore } from "lib/store.js";

export const methods = ["GET"];
export const access = "member";

export default async function (_req, res) {
  const store = createStore(db);
  const [job, runs, sources] = await Promise.all([
    currentRefresh(db),
    store.recentRuns(10),
    store.listSources(),
  ]);
  res.json({
    refresh: job,
    latestRun: runs[0] ?? null,
    runs,
    sources,
  });
}
