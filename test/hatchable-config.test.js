import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../lib/config.js";

test("configuration uses safe defaults and keeps absent optional credentials absent", async () => {
  const config = await loadConfig({ get: async () => null });
  assert.equal(config.windowDays, 90);
  assert.equal(config.fetchConcurrency, 4);
  assert.equal(config.tpdbApiKey, undefined);
  assert.equal(config.sxyprnRelayUrl, undefined);
  assert.equal(config.sxyprnRelaySecret, undefined);
  assert.ok(config.traxxxWatchlist.length > 0);
});

test("configuration loads declared secret and owner settings per request", async () => {
  const values = new Map([
    ["TPDB_API_KEY", "test-key"],
    ["window_days", 30],
    ["traxxx_watchlist", "https://traxxx.me/studios/example"],
    ["SXYPRN_RELAY_URL", "https://relay.example"],
    ["SXYPRN_RELAY_SECRET", "test-relay-secret"],
  ]);
  const config = await loadConfig({ get: async (key) => values.get(key) ?? null });
  assert.equal(config.tpdbApiKey, "test-key");
  assert.equal(config.windowDays, 30);
  assert.deepEqual(config.traxxxWatchlist, ["https://traxxx.me/studios/example"]);
  assert.equal(config.sxyprnRelayUrl, "https://relay.example/");
  assert.equal(config.sxyprnRelaySecret, "test-relay-secret");
});

test("invalid editable values fail without including a saved secret", async () => {
  const values = new Map([
    ["TPDB_API_KEY", "never-print-this"],
    ["window_days", -1],
  ]);
  await assert.rejects(
    loadConfig({ get: async (key) => values.get(key) ?? null }),
    (error) => /window_days/.test(error.message) && !error.message.includes("never-print-this"),
  );
});
