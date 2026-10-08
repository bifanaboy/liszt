import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";

test("scene writes replace the row and its links in one database transaction", async () => {
  let transaction;
  const store = createStore({
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async (statements) => {
      transaction = statements;
    },
  });
  await store.upsertScene({
    id: "source:1",
    sourceId: "source",
    source: "example",
    labelId: "source",
    label: "Example",
    title: "Release",
    performers: ["Performer"],
    releaseDate: "2026-10-01",
    durationSec: 600,
    thumbnailUrl: "",
    tags: [],
    provenance: [{ source: "example", fetchedAt: "2026-10-01T00:00:00Z" }],
    fieldProvenance: {},
    metadataPoor: false,
    studioMetadataCheckedAt: null,
    videoCheckedAt: null,
    videoMatching: null,
    videoUrls: [
      {
        source: "eporner",
        url: "https://example.com/watch",
        verifiedAt: "2026-10-01T00:00:00Z",
        verifyFailures: 0,
      },
    ],
    deadVideoUrls: [],
  });
  assert.equal(transaction.length, 3);
  assert.match(transaction[0].sql, /ON CONFLICT \(id\) DO UPDATE/);
  assert.match(transaction[1].sql, /DELETE FROM scene_links/);
  assert.match(transaction[2].sql, /INSERT INTO scene_links/);
  assert.ok(transaction[0].params.includes(JSON.stringify(["Performer"])));
});

test("provider observations preserve fields omitted by a later source poll", async () => {
  const writes = [];
  const store = createStore({
    query: async (sql) => {
      if (sql.startsWith("SELECT provider_id"))
        return {
          rows: [
            {
              provider_id: "feed",
              studio_id: "s",
              record_json: { title: "Release", performers: ["P"] },
            },
          ],
        };
      return { rows: [], rowCount: 1 };
    },
    transaction: async (statements) => {
      writes.push(...statements);
      return [];
    },
  });
  await store.upsertProviderObservation({
    providerId: "feed",
    recordId: "1",
    studioId: "s",
    sceneId: "feed:1",
    studio: "S",
    record: { title: "Updated", performers: [] },
    fetchedAt: "2026-10-01T00:00:00Z",
  });
  const saved = JSON.parse(writes[0].params[5]);
  assert.deepEqual(saved.performers, ["P"]);
  assert.equal(saved.title, "Updated");
});

test("undated pool scans use persistent progress and insertion order", async () => {
  let statement;
  const store = createStore({
    query: async (sql, params) => {
      statement = { sql, params };
      return { rows: [], rowCount: 0 };
    },
    transaction: async () => [],
  });
  assert.deepEqual(await store.poolVideosUndated("uploader", 7), []);
  assert.match(statement.sql, /undated_scanned_at ASC NULLS FIRST, indexed_order ASC LIMIT \$2/);
  assert.deepEqual(statement.params, ["uploader", 7]);
});

test("invalid scene dates are rejected before a database write", async () => {
  let writes = 0;
  const store = createStore({
    query: async () => ({ rows: [], rowCount: 0 }),
    transaction: async () => {
      writes += 1;
    },
  });
  await assert.rejects(
    store.upsertScene({
      id: "source:1",
      sourceId: "source",
      source: "example",
      labelId: "source",
      title: "Release",
      releaseDate: "2026-02-30",
      performers: [],
      tags: [],
      provenance: [{ source: "example", fetchedAt: "2026-10-01T00:00:00Z" }],
      videoUrls: [],
      deadVideoUrls: [],
    }),
    /Invalid scene at store boundary/,
  );
  assert.equal(writes, 0);
});
