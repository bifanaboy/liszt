import assert from "node:assert/strict";
import test from "node:test";
import { createSync } from "../lib/sync.js";

test("the Hatchable sync port awaits storage and keeps provider failures sanitized", async () => {
  const sourcesById = new Map();
  const runs = [];
  const store = {
    recordRun: async (run) => runs.push(run),
    pruneScenesForUnknownSources: async () => 0,
    listWindow: async () => [],
    listProviderObservations: async () => [],
    listSources: async () => [...sourcesById.values()],
    upsertSource: async (source) => sourcesById.set(source.sourceId, source),
    deleteReleasedBefore: async () => [],
  };
  const source = {
    id: "example-feed",
    name: "Example Feed",
    authority: { name: "Example Feed", url: "https://example.test" },
    matcher: null,
    fetch: async () => {
      throw new Error("Bearer configured-secret <html>private response</html>");
    },
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} };
  const run = createSync({
    store,
    sources: [source],
    fetcher: {},
    clock: { now: () => new Date("2026-10-08T00:00:00.000Z") },
    log,
    windowDays: 90,
    fetchConcurrency: 1,
    lookups: {},
    resolveEnabled: false,
    logSecrets: ["configured-secret"],
  });
  const summary = await run("test");
  assert.equal(summary.ok, false);
  assert.equal(summary.outcomes[0].error, "Bearer [redacted] [response body omitted]");
  assert.equal(sourcesById.get(source.id).lastError, summary.outcomes[0].error);
  assert.equal(runs.at(-1).ok, false);
});
