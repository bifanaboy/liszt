import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifySourceStatus,
  renderSourceHealth,
  renderSourceHealthSummary,
  sourceCardState,
  sourceHealth,
  sourceScenes,
  sourceStateLabel,
  studioChoices,
  visibleSourceStatuses,
} from "../public/source-health.js";

const FC2_STUB_ERROR =
  "fc2cmadb.com is not implemented: its interface is unconfirmed. This is a setup gap, not a source outage; the FC2 lane has no records and the other lanes are unaffected.";

test("classifySourceStatus gives an unimplemented source its own setup-gap state", () => {
  assert.equal(classifySourceStatus(undefined), "ok");
  assert.equal(
    classifySourceStatus("Maximo Garcia is not configured (set LISZT_MAXIMO_LISTING_URL)"),
    "config",
  );
  assert.equal(classifySourceStatus(FC2_STUB_ERROR), "unimplemented");
  assert.equal(
    classifySourceStatus("Bang! Originals listing has an unexpected structured response"),
    "failing",
  );
});

test("the card badge renders both setup-gap states as SETUP REQUIRED", () => {
  assert.equal(sourceCardState(undefined), "ok");
  assert.equal(sourceCardState("Maximo Garcia is not configured"), "setup");
  assert.equal(sourceCardState(FC2_STUB_ERROR), "setup");
  assert.equal(
    sourceCardState("Bang! Originals listing has an unexpected structured response"),
    "error",
  );
});

test("the status line, hint and badge agree for every source state", () => {
  assert.equal(sourceStateLabel(undefined), "Sync ok");
  assert.equal(sourceStateLabel("not configured"), "Not configured");
  assert.equal(sourceStateLabel(FC2_STUB_ERROR), "Not implemented");
  assert.equal(sourceStateLabel("upstream failed"), "Sync failing");

  const unimplemented = renderSourceHealth(
    { sourceId: "fc2cmadb", labelId: "fc2cmadb", lastError: FC2_STUB_ERROR },
    [],
  );
  assert.match(unimplemented, /Not implemented/);
  assert.match(unimplemented, /Deploy configuration, not a source outage/);
  assert.doesNotMatch(unimplemented, /Sync failing/);

  const failing = renderSourceHealth(
    { sourceId: "legacy-provider", labelId: "legacy-provider", lastError: "upstream failed" },
    [],
  );
  assert.match(failing, /Sync failing/);
  assert.doesNotMatch(failing, /Deploy configuration/);
});

test("the summary counts failing, unconfigured and unimplemented sources apart", () => {
  const sources = [
    { sourceId: "vixen-anal", labelId: "vixen-anal" },
    {
      sourceId: "legacy-provider",
      labelId: "legacy-provider",
      lastError: "Bang! Originals listing has an unexpected structured response",
    },
    {
      sourceId: "maximo-garcia",
      labelId: "maximo-garcia",
      lastError: "Maximo Garcia is not configured (set LISZT_MAXIMO_LISTING_URL)",
    },
    { sourceId: "fc2cmadb", labelId: "fc2cmadb", lastError: FC2_STUB_ERROR },
  ];
  const summary = renderSourceHealthSummary(sources);
  assert.match(summary, /1 source failing/);
  assert.match(summary, /1 source not configured/);
  assert.match(summary, /1 source not implemented/);
  assert.equal(renderSourceHealthSummary([{ sourceId: "vixen-anal", labelId: "vixen-anal" }]), "");
});

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

test("source health counts a provider's records after duplicate rows collapse", () => {
  const merged = {
    sourceId: "manyvids-1",
    labelId: "network-brazzers-anal",
    contributingSourceIds: ["manyvids-1", "tpdb-watchlist"],
    videoUrls: [],
  };
  assert.deepEqual(
    sourceScenes({ sourceId: "tpdb-watchlist", labelId: "tpdb-watchlist" }, [merged]),
    [merged],
  );
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
