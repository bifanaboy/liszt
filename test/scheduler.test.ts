/**
 * The scheduler and the logger, on the two properties that decide whether a
 * shutdown is clean.
 *
 *  - `stop()` used to `clearInterval` and return, leaving the cycle that was
 *    already running to write into a store the caller was about to close. That
 *    surfaces as `SQLITE_BUSY` or a write on a closed handle, not as an exit.
 *  - The logger must never throw. Its `fields` come from parsed remote payloads,
 *    so a BigInt, a cycle or a hostile `toJSON` must not take down the pipeline
 *    step that happened to log it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../src/pipeline/scheduler.ts";
import { JsonLogger } from "../src/core/logger.ts";

test("stop() waits for the in-flight cycle before it resolves", async () => {
  let finish: (() => void) | undefined;
  let started = 0;
  const order: string[] = [];
  const scheduler = createScheduler({
    intervalMs: 5,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    run: async () => {
      started += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      order.push("cycle done");
    },
  });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(scheduler.busy());
  assert.ok(started >= 1);

  const stopped = scheduler.stop().then(() => order.push("stop returned"));
  // The stop is pending while the cycle is: the point of the whole change.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(order.includes("stop returned"), false, "stop() resolved before the cycle finished");
  finish?.();
  await stopped;
  assert.deepEqual(order, ["cycle done", "stop returned"]);
  assert.equal(scheduler.busy(), false);
});

test("a second tick cannot start a cycle on top of one in flight", async () => {
  let started = 0;
  let finish: (() => void) | undefined;
  const scheduler = createScheduler({
    intervalMs: 5,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    run: async () => {
      started += 1;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(started, 1, "the interval fired repeatedly and overlapped itself");
  finish?.();
  await scheduler.stop();
});

test("stop() gives up on a wedged cycle instead of hanging shutdown", async () => {
  const scheduler = createScheduler({
    intervalMs: 5,
    stopTimeoutMs: 30,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    // Never settles.
    run: () => new Promise(() => {}),
  });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const startedAt = Date.now();
  const clean = await scheduler.stop();
  assert.ok(Date.now() - startedAt < 1000, "the bounded wait held");
  // AND it says so. The caller closes the SQLite store on `true`, so resolving
  // `true` here would pull the handle out from under a live writer.
  assert.equal(clean, false, "a cycle still running is not a clean stop");
});

test("stop() reports a clean stop once the cycle settles", async () => {
  let finish: (() => void) | undefined;
  const scheduler = createScheduler({
    intervalMs: 5,
    stopTimeoutMs: 10_000,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    run: async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  });
  scheduler.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopped = scheduler.stop();
  finish?.();
  assert.equal(await stopped, true, "the cycle finished inside the bound");
});

test("stop() on an idle scheduler is clean", async () => {
  const scheduler = createScheduler({
    intervalMs: 1000,
    log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } },
    run: async () => undefined,
  });
  assert.equal(await scheduler.stop(), true);
  assert.equal(scheduler.busy(), false);
});

test("the logger writes a line for fields JSON cannot represent", () => {
  const lines: string[] = [];
  const log = new JsonLogger({ component: "test" }, (line) => lines.push(line));
  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic.self = cyclic;

  log.info("hostile fields", {
    big: 10n,
    cyclic,
    when: new Date("2026-03-04T00:00:00Z"),
    nested: { deep: { deeper: [1, 2, { also: "fine" }] } },
  });
  const entry = JSON.parse(lines[0] as string);
  assert.equal(entry.message, "hostile fields");
  assert.equal(entry.component, "test");
  assert.equal(entry.big, "10", "a BigInt is stringified, not thrown on");
  assert.equal(entry.cyclic.self, "[circular]");
  assert.equal(entry.when, "2026-03-04T00:00:00.000Z");
  assert.deepEqual(entry.nested, { deep: { deeper: [1, 2, { also: "fine" }] } });
});

test("a field cannot overwrite the log envelope", () => {
  // `...fields` spread last, so a remote payload carrying `level` or `ts` used
  // to rewrite the envelope - and every log filter keyed on those fields broke.
  const lines: string[] = [];
  new JsonLogger({}, (line) => lines.push(line)).warn("real message", {
    level: "error",
    ts: "1999-01-01T00:00:00.000Z",
    message: "forged",
  });
  const entry = JSON.parse(lines[0] as string);
  assert.equal(entry.level, "warn");
  assert.equal(entry.message, "real message");
  assert.notEqual(entry.ts, "1999-01-01T00:00:00.000Z");
});

test("a broken sink does not propagate into the pipeline", () => {
  const log = new JsonLogger({}, () => {
    throw new Error("stdout is gone");
  });
  assert.doesNotThrow(() => log.error("still fine"));
});
