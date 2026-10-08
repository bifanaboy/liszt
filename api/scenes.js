import { db } from "hatchable";
import { createStore } from "lib/store.js";
import { currentRefresh } from "lib/refresh-jobs.js";
import { ASIAN_SOURCE_IDS } from "lib/sources/registry.js";

export const methods = ["GET"];
export const access = "member";

export default async function (_req, res) {
  const store = createStore(db);
  const [scenes, sources, observations, runs, refresh] = await Promise.all([
    store.listAll(),
    store.listSources(),
    store.listProviderObservations(),
    store.recentRuns(1),
    currentRefresh(db),
  ]);
  const providersByScene = new Map();
  for (const item of observations) {
    const providers = providersByScene.get(item.sceneId) ?? new Set();
    providers.add(item.providerId);
    providersByScene.set(item.sceneId, providers);
  }
  res.json({
    generatedAt: new Date().toISOString(),
    scenes: scenes.map((scene) => ({
      ...scene,
      contributingSourceIds: [...(providersByScene.get(scene.id) ?? [])],
    })),
    sources,
    asianSourceIds: ASIAN_SOURCE_IDS,
    refreshing: ["queued", "running"].includes(refresh?.status),
    latestRun: runs[0] ?? null,
    progress: {
      active: ["queued", "running"].includes(refresh?.status),
      runId: refresh?.runId ?? null,
      startedAt: refresh?.startedAt ?? null,
      stage:
        refresh?.status === "failed"
          ? "error"
          : refresh?.status === "complete"
            ? "idle"
            : refresh
              ? "populating"
              : "idle",
      index: { done: 0, total: 0, current: "" },
      populate: { done: 0, total: 0, current: [] },
      link: { done: 0, total: 0, matched: 0, substage: "resolve", verifyDone: 0, verifyTotal: 0 },
    },
  });
}
