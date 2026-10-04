import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("TPDB API key is read from its environment variable", () => {
  assert.equal(loadConfig({}).tpdbApiKey, undefined);
  assert.equal(loadConfig({ TPDB_API_KEY: "  token-value  " }).tpdbApiKey, "token-value");
});
