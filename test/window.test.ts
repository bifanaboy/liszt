import { test } from "node:test";
import assert from "node:assert/strict";
import { DateOnly } from "../src/core/schema.ts";
import { dateOnly } from "../src/pipeline/sync.ts";

test("dateOnly produces a UTC date-only string", () => {
  assert.equal(dateOnly(new Date("2026-03-04T23:30:00Z")), "2026-03-04");
});

test("window arithmetic crosses month and year boundaries", () => {
  const now = new Date("2026-03-01T00:00:00Z");
  const from = dateOnly(new Date(now.getTime() - 90 * 86_400_000));
  assert.equal(from, "2025-12-01");
});

test("DateOnly accepts real calendar dates and rejects impossible ones", () => {
  assert.ok(DateOnly.safeParse("2024-02-29").success);
  assert.equal(DateOnly.safeParse("2023-02-29").success, false);
  assert.equal(DateOnly.safeParse("2026-13-01").success, false);
  // A full timestamp does not parse: window arithmetic can never silently drop
  // a time component.
  assert.equal(DateOnly.safeParse("2026-03-04T10:00:00Z").success, false);
});