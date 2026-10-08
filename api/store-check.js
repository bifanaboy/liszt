import { db } from "hatchable";
import { createStore } from "lib/store.js";

export const access = "admin";
export const methods = ["POST"];

export default async function (_req, res) {
  const store = createStore(db);
  const now = new Date().toISOString();
  const scene = {
    id: "hatchable-check:scene",
    sourceId: "hatchable-check",
    source: "test",
    labelId: "hatchable-check",
    label: "Check",
    title: "Storage check",
    performers: ["Test"],
    releaseDate: "2026-10-08",
    durationSec: 600,
    thumbnailUrl: "",
    tags: [],
    provenance: [{ source: "test", fetchedAt: now }],
    fieldProvenance: {},
    metadataPoor: false,
    studioMetadataCheckedAt: null,
    videoCheckedAt: null,
    videoMatching: null,
    videoUrls: [
      { source: "eporner", url: "https://example.com/check", verifiedAt: now, verifyFailures: 0 },
    ],
    deadVideoUrls: [],
  };
  await store.upsertScene(scene);
  const saved = await store.getScene(scene.id);
  await store.upsertProviderObservation({
    providerId: "check",
    recordId: "1",
    studioId: "check",
    sceneId: scene.id,
    studio: "Check",
    record: { title: "Storage check", performers: ["Test"] },
    fetchedAt: now,
  });
  const observations = await store.listProviderObservations(scene.id);
  const persistedCounter = Number((await store.getPoolMeta("store-check-count")) ?? 0) + 1;
  await store.setPoolMeta("store-check-count", String(persistedCounter));
  await store.upsertPoolVideo({
    id: "check-video",
    uploader: "store-check",
    title: "Check",
    added: "2026-10-08 12:00:00",
    durationSec: 600,
    hydratedAt: null,
    views: null,
  });
  const poolStored = (await store.poolVideosForUploader("store-check")).some(
    (video) => video.id === "check-video",
  );
  await store.noteFc2Sightings([{ videoId: "check-fc2", releaseDate: "2026-10-08" }], now);
  await store.decideFc2Candidate("check-fc2", "accepted", "test", {
    checkedAt: now,
    scene: { id: "check" },
  });
  const fc2Stored = (await store.fc2Candidate("check-fc2"))?.scene?.id === "check";
  let rolledBack = false;
  try {
    await store.transaction([
      {
        sql: "INSERT INTO pool_meta(key,value) VALUES($1,$2)",
        params: ["transaction-check", "must rollback"],
      },
      {
        sql: "INSERT INTO scene_links(scene_id,kind,source,url) VALUES($1,$2,$3,$4)",
        params: ["missing-scene", "live", "eporner", "https://example.com/missing"],
      },
    ]);
  } catch {
    const result = await store.getPoolMeta("transaction-check");
    rolledBack = result === null;
  }
  await store.prunePoolMissing("store-check", new Set());
  await store.deleteFc2CandidatesBefore("9999-12-31");
  await store.deleteScene(scene.id);
  res.json({
    sceneRoundTrip: saved?.title === scene.title && saved.videoUrls.length === 1,
    providerStored: observations.length === 1,
    persistedCounter,
    poolStored,
    fc2Stored,
    transactionRollback: rolledBack,
  });
}
