/**
 * The live progress tracker.
 *
 * It has no dependencies and touches nothing, so the properties that matter are
 * all about what it refuses to do:
 *
 *   - a counter that can exceed its total renders a bar past 100% and reads as
 *     a bug in the app rather than in the network it was watching;
 *   - a counter that can go BACKWARDS renders as a stalled-then-jumping bar, so
 *     nothing may move a count backwards;
 *   - a snapshot that aliases internal state can be observed half-written, so
 *     every snapshot is a deep copy;
 *   - and because the composition root reuses ONE tracker across every refresh
 *     trigger, `begin()` has to reset everything - a crashed run must not leave
 *     counters behind for the next reader to mistake for a live run.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgressTracker, idleProgress } from "../src/pipeline/progress.ts";

const START = "2026-03-10T00:00:00Z";

function begun() {
  const tracker = createProgressTracker();
  tracker.begin("cycle-1", START, { sources: 6, uploaders: 4 });
  return tracker;
}

test("an untouched tracker is idle, not a stalled run", () => {
  const snapshot = createProgressTracker().snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.stage, "idle");
  assert.equal(snapshot.runId, null);
  assert.equal(snapshot.startedAt, null);
  assert.deepEqual(snapshot.populate, { done: 0, total: 0, current: [] });
  assert.deepEqual(snapshot.link, {
    done: 0,
    total: 0,
    matched: 0,
    substage: "resolve",
    verifyDone: 0,
    verifyTotal: 0,
  });
  assert.deepEqual(idleProgress(), snapshot);
});

test("begin() carries the run's identity and the denominators", () => {
  const snapshot = begun().snapshot();
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.runId, "cycle-1");
  assert.equal(snapshot.startedAt, START);
  assert.equal(snapshot.stage, "populating", "a cycle starts by polling sources");
  assert.equal(snapshot.index.total, 4);
  assert.equal(snapshot.populate.total, 6);
});

test("an inactive tracker absorbs everything, so a stray event cannot invent a run", () => {
  const tracker = createProgressTracker();
  tracker.stage("linking");
  tracker.sourceStart("mambo-perv");
  tracker.sourceDone("mambo-perv");
  tracker.linkStep(1, 2, 0);
  tracker.verifyStep(1, 1);
  tracker.indexStep(1, 1, "Vovick17");
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.stage, "idle");
  assert.equal(snapshot.populate.done, 0);
  assert.equal(snapshot.populate.current.length, 0);
  assert.equal(snapshot.link.done, 0);
  assert.equal(snapshot.link.verifyDone, 0);
  assert.equal(snapshot.index.done, 0);
});

test("source progress counts in-flight sources and reaches its total", () => {
  const tracker = begun();
  tracker.stage("populating");
  tracker.sourceStart("tushy");
  tracker.sourceStart("mambo-perv");
  assert.deepEqual(tracker.snapshot().populate.current, ["tushy", "mambo-perv"]);
  tracker.sourceDone("tushy");
  assert.deepEqual(tracker.snapshot().populate.current, ["mambo-perv"]);
  assert.equal(tracker.snapshot().populate.done, 1);
  for (const id of ["mambo-perv", "madouqu", "tushy", "jelly", "a", "b"]) tracker.sourceDone(id);
  assert.equal(tracker.snapshot().populate.done, 6, "a late duplicate cannot pass the total");
  assert.deepEqual(tracker.snapshot().populate.current, []);
});

test("a source that is started twice appears once", () => {
  const tracker = begun();
  tracker.sourceStart("tushy");
  tracker.sourceStart("tushy");
  assert.deepEqual(tracker.snapshot().populate.current, ["tushy"]);
});

test("link progress is clamped to the queue and tracks the latest report, including rewinds", () => {
  const tracker = begun();
  tracker.stage("linking");
  tracker.linkStart(121);
  tracker.linkStep(48, 121, 3);
  assert.equal(tracker.snapshot().link.done, 48);
  assert.equal(tracker.snapshot().link.matched, 3);
  // Overshoots are clamped to the queue, but a later report can rewind the
  // count: the tracker keeps the latest report rather than accumulating it.
  tracker.linkStep(500, 121, 500);
  assert.equal(tracker.snapshot().link.done, 121);
  assert.equal(tracker.snapshot().link.matched, 121);
  tracker.linkStep(10, 121, 1);
  assert.equal(
    tracker.snapshot().link.done,
    10,
    "the counter tracks the last report, it does not accumulate",
  );
});

test("a shrinking queue corrects its own denominator", () => {
  // `lookups.limit` can cut the queue after the first report, and eligibility
  // filtering can shrink it before the first one.
  const tracker = begun();
  tracker.linkStart(121);
  tracker.linkStart(25);
  tracker.linkStep(1, 25, 0);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.link.total, 25);
  assert.equal(snapshot.link.done, 1);
});

test("a stage with no countable total is zero, not a lie", () => {
  const tracker = begun();
  tracker.linkStart(0);
  tracker.linkStep(0, 0, 0);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.link.total, 0);
  assert.equal(snapshot.link.done, 0);
  assert.equal(snapshot.link.matched, 0);
});

test("re-verify is its own substage, counted separately from the resolve queue", () => {
  const tracker = begun();
  tracker.stage("verifying");
  tracker.verifyStart(25);
  assert.equal(tracker.snapshot().link.substage, "verify");
  assert.equal(tracker.snapshot().link.verifyDone, 0);
  tracker.verifyStep(7, 25);
  tracker.verifyStep(25, 25);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.link.verifyDone, 25);
  assert.equal(snapshot.link.verifyTotal, 25);
});

test("an empty re-verify slice reports a real zero rather than nothing at all", () => {
  const tracker = begun();
  tracker.verifyStart(0);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.link.verifyTotal, 0);
  assert.equal(snapshot.link.verifyDone, 0);
  assert.equal(snapshot.link.substage, "verify", "the stage ran, and it ran over nothing");
});

test("legacy index counters remain isolated from source progress", () => {
  const tracker = begun();
  tracker.indexStep(2, 4, "Rafael12021988");
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.index.done, 2);
  assert.equal(snapshot.index.current, "Rafael12021988");
  tracker.indexStep(9, 4, "wmrt0s");
  assert.equal(tracker.snapshot().index.done, 4, "clamped to the account count");
});

test("finish() ends the run but keeps what it reached", () => {
  const tracker = begun();
  tracker.stage("populating");
  tracker.sourceStart("tushy");
  tracker.sourceDone("tushy");
  tracker.finish();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.stage, "idle");
  assert.equal(snapshot.populate.done, 1, "the outcome is still readable after the bar collapses");
  tracker.sourceDone("mambo-perv");
  assert.equal(tracker.snapshot().populate.done, 1, "a late event after the end moves nothing");
});

test("fail() ends the run and says so", () => {
  const tracker = begun();
  tracker.stage("linking");
  tracker.linkStart(10);
  tracker.linkStep(4, 10, 1);
  tracker.fail();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.stage, "error");
  assert.equal(snapshot.link.done, 4, "how far it got survives the failure");
});

test("begin() resets a run that never finished", () => {
  const tracker = begun();
  tracker.stage("linking");
  tracker.linkStart(121);
  tracker.linkStep(90, 121, 12);
  tracker.indexStep(4, 4, "wmrt0s");
  // A crash: no finish(), no fail(). The next cycle begins on the same tracker.
  tracker.begin("cycle-2", "2026-03-10T00:10:00Z", { sources: 6, uploaders: 4 });
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.runId, "cycle-2");
  assert.equal(snapshot.stage, "populating");
  assert.equal(snapshot.link.done, 0, "no stale link count from the dead run");
  assert.equal(snapshot.link.total, 0);
  assert.equal(snapshot.link.matched, 0);
  assert.equal(snapshot.index.done, 0);
  assert.deepEqual(snapshot.populate.current, []);
});

test("a snapshot is a deep copy, so a reader cannot observe internal state", () => {
  const tracker = begun();
  tracker.sourceStart("tushy");
  const first = tracker.snapshot();
  tracker.sourceDone("tushy");
  tracker.linkStep(5, 10, 1);
  assert.deepEqual(first.populate, { done: 0, total: 6, current: ["tushy"] });
  assert.equal(first.link.done, 0);
  // And the reverse: mutating a snapshot must not corrupt the tracker.
  first.populate.current.push("forged");
  first.link.done = 99;
  const fresh = tracker.snapshot();
  assert.deepEqual(fresh.populate.current, []);
  assert.equal(fresh.link.done, 5);
});

test("nonsense counters are refused rather than rendered", () => {
  const tracker = begun();
  tracker.linkStart(Number.NaN);
  tracker.linkStep(-3, -1, Number.POSITIVE_INFINITY);
  const snapshot = tracker.snapshot();
  assert.equal(snapshot.link.total, 0);
  assert.equal(snapshot.link.done, 0);
  assert.equal(snapshot.link.matched, 0);
  tracker.begin("cycle-3", START, { sources: -3, uploaders: Number.NaN });
  assert.equal(tracker.snapshot().populate.total, 0);
  assert.equal(tracker.snapshot().index.total, 0);
});
