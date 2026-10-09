import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore, type RunRecord } from "../src/core/store/sqlite.ts";

const run = (id: string): RunRecord => ({
  id,
  kind: "sync",
  startedAt: `2026-10-02T00:00:0${id.length}Z`,
  endedAt: null,
  outcomes: [],
  ok: null,
  error: null,
  resolverHealth: null,
});

test("caught nested failures roll back their writes and allow the outer transaction to commit", () => {
  const store = new SqliteStore(":memory:");
  const failure = new Error("nested failure");
  try {
    store.migrate();
    store.transaction(() => {
      store.recordRun(run("outer"));
      assert.throws(
        () =>
          store.transaction(() => {
            store.recordRun(run("nested"));
            throw failure;
          }),
        (error) => error === failure,
      );
      assert.deepEqual(
        store.recentRuns(10).map(({ id }) => id),
        ["outer"],
      );
      store.transaction(() => store.recordRun(run("sibling")));
    });
    assert.deepEqual(
      store.recentRuns(10).map(({ id }) => id),
      ["sibling", "outer"],
    );
    assert.throws(
      () =>
        store.transaction(() => {
          store.recordRun(run("later"));
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.deepEqual(
      store.recentRuns(10).map(({ id }) => id),
      ["sibling", "outer"],
    );
  } finally {
    store.close();
  }
});

test("an outer failure rolls back successful nested writes and permits a new transaction", () => {
  const store = new SqliteStore(":memory:");
  try {
    store.migrate();
    assert.throws(
      () =>
        store.transaction(() => {
          store.transaction(() => store.recordRun(run("nested")));
          throw new Error("outer failure");
        }),
      /outer failure/,
    );
    assert.deepEqual(store.recentRuns(10), []);
    store.transaction(() => store.transaction(() => store.recordRun(run("fresh"))));
    assert.equal(store.recentRuns(1)[0]?.id, "fresh");
  } finally {
    store.close();
  }
});
