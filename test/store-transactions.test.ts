import { test } from "node:test";
import assert from "node:assert/strict";
import { SqliteStore } from "../src/core/store/sqlite.ts";

test("caught nested failures roll back their writes and allow the outer transaction to commit", () => {
  const store = new SqliteStore(":memory:");
  const failure = new Error("nested failure");
  try {
    store.migrate();
    const result = store.transaction(() => {
      store.setPoolMeta("outer", "before");
      assert.throws(
        () =>
          store.transaction(() => {
            store.setPoolMeta("outer", "overwritten");
            store.transaction(() => store.setPoolMeta("deep", "rolled back"));
            throw failure;
          }),
        (error) => error === failure,
      );
      assert.equal(store.getPoolMeta("outer"), "before");
      assert.equal(store.getPoolMeta("deep"), null);
      return store.transaction(() => {
        store.setPoolMeta("sibling", "committed");
        return 42;
      });
    });
    assert.equal(result, 42);
    assert.equal(store.getPoolMeta("outer"), "before");
    assert.equal(store.getPoolMeta("sibling"), "committed");
    assert.throws(
      () =>
        store.transaction(() => {
          store.setPoolMeta("later", "rolled back");
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.equal(store.getPoolMeta("later"), null);
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
          store.transaction(() => store.setPoolMeta("nested", "rolled back"));
          throw new Error("outer failure");
        }),
      /outer failure/,
    );
    assert.equal(store.getPoolMeta("nested"), null);
    store.transaction(() => store.transaction(() => store.setPoolMeta("fresh", "committed")));
    assert.equal(store.getPoolMeta("fresh"), "committed");
  } finally {
    store.close();
  }
});
