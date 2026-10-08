import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createManyVidsSource } from "../lib/sources/manyvids.js";

const page = JSON.parse(
  await readFile(new URL("./fixtures/manyvids-store.json", import.meta.url), "utf8"),
);
const onePage = {
  data: page.data.map((video) => ({ ...video, tags: ["anal"] })),
  pagination: { total: page.data.length, totalPages: 1, currentPage: 1, nextPage: null },
};

test("ManyVids validates a fetched page and persists its snapshot asynchronously", async () => {
  let saved;
  const store = {
    async getSourceSnapshot() {
      return saved ?? null;
    },
    async setSourceSnapshot(_id, value) {
      saved = value;
    },
  };
  const source = createManyVidsSource({ storeId: "1003095958", store, minIntervalMs: 0 });
  const result = await source.fetch("2026-01-01", {
    now: new Date("2026-10-08T00:00:00Z"),
    log() {},
    fetcher: { json: async () => onePage },
  });
  assert.ok(saved, "the async database write completes before fetch resolves");
  assert.equal(JSON.parse(saved).videos.length, onePage.data.length);
  assert.equal(
    result.scenes.every((scene) => scene.provenance.source === "ManyVids"),
    true,
  );
});

test("ManyVids rejects malformed provider pages instead of saving them", async () => {
  let saved = false;
  const source = createManyVidsSource({
    storeId: "1003095958",
    store: {
      async getSourceSnapshot() {
        return null;
      },
      async setSourceSnapshot() {
        saved = true;
      },
    },
    minIntervalMs: 0,
  });
  await assert.rejects(
    () =>
      source.fetch("2026-01-01", {
        now: new Date("2026-10-08T00:00:00Z"),
        log() {},
        fetcher: { json: async () => ({ invalid: true }) },
      }),
    /Schema violation/,
  );
  assert.equal(saved, false);
});
