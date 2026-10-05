import assert from "node:assert/strict";
import test from "node:test";
import { isExcludedMaximoTitle } from "../src/sources/maximo-garcia.ts";

test("Maximo excludes the standalone trans title marker", () => {
  assert.equal(isExcludedMaximoTitle("Studio scene trans bonus"), true);
  assert.equal(isExcludedMaximoTitle("Studio scene TRANs bonus"), true);
  assert.equal(isExcludedMaximoTitle("Studio scene transport bonus"), false);
  assert.equal(isExcludedMaximoTitle("Studio scene transition bonus"), false);
});
