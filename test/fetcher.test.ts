import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStatus, FetchError, classifyError } from "../src/core/fetcher.ts";

test("404/410 are definitive; everything else is inconclusive", () => {
  assert.equal(classifyStatus(404), "definitive");
  assert.equal(classifyStatus(410), "definitive");
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    assert.equal(classifyStatus(status), "inconclusive");
  }
});

test("classifyError defaults to inconclusive for non-FetchErrors", () => {
  assert.equal(classifyError(new Error("network down")), "inconclusive");
  assert.equal(classifyError(new FetchError("gone", "definitive", 404)), "definitive");
});