import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceHealth, studioChoices, visibleSourceStatuses } from "../public/source-health.js";

const scenes = [
  {
    sourceId: "vixen-anal",
    labelId: "tushy",
    label: "Tushy",
    videoUrls: [{ url: "https://tube.test/1" }],
  },
  { sourceId: "vixen-anal", labelId: "blacked", label: "Blacked", videoUrls: [] },
  { sourceId: "madouqu", labelId: "madouqu-peach", label: "Peach", videoUrls: [] },
];

test("child source health counts only scenes with the child's label", () => {
  const health = sourceHealth({ sourceId: "vixen-anal", labelId: "tushy" }, scenes);
  assert.equal(health.sceneCount, 1);
  assert.equal(health.liveCount, 1);
  assert.equal(health.matchPercent, 100);
});

test("healthy lane rows hide behind children while failed and childless lanes remain visible", () => {
  const child = { sourceId: "vixen-anal", labelId: "tushy", label: "Tushy" };
  const healthyLane = { sourceId: "vixen-anal", labelId: "vixen-anal", label: "Vixen" };
  const failedLane = { ...healthyLane, lastError: "upstream failed" };
  const childless = { sourceId: "madouqu", labelId: "madouqu", label: "Madouqu" };
  assert.deepEqual(visibleSourceStatuses([healthyLane, child, childless]), [child, childless]);
  assert.deepEqual(visibleSourceStatuses([failedLane, child, childless]), [
    failedLane,
    child,
    childless,
  ]);
});

test("studio choices come from scene labels, including Madouqu sub-labels and no lane rows", () => {
  assert.deepEqual(studioChoices(scenes), [
    { labelId: "tushy", label: "Tushy", sceneCount: 1 },
    { labelId: "blacked", label: "Blacked", sceneCount: 1 },
    { labelId: "madouqu-peach", label: "Peach", sceneCount: 1 },
  ]);
});
