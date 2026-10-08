import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "../lib/validation.js";

test("nested object schemas trim, default, preserve nullable values, and strip unknown keys", () => {
  const schema = z.object({
    name: z.string().trim().min(1),
    tags: z.array(z.string().min(1)).default([]),
    value: z.number().int().positive().nullable().optional(),
  });
  assert.deepEqual(schema.parse({ name: "  Name  ", value: null, extra: true }), {
    name: "Name",
    tags: [],
    value: null,
  });
  assert.equal(schema.safeParse({ name: "  " }).success, false);
});

test("URL, UUID, date-time, and custom refinements reject malformed boundary values", () => {
  const schema = z.object({
    url: z.string().url(),
    uuid: z.string().uuid(),
    timestamp: z.string().datetime({ offset: true }),
    positive: z.number().refine((value) => value > 0, "must be positive"),
  });
  assert.equal(
    schema.safeParse({
      url: "https://example.com/path",
      uuid: "72d78735-5301-4b09-9383-71faa812e110",
      timestamp: "2026-10-08T12:00:00Z",
      positive: 1,
    }).success,
    true,
  );
  assert.equal(
    schema.safeParse({ url: "not a url", uuid: "x", timestamp: "y", positive: 0 }).success,
    false,
  );
});

test("union and passthrough preserve the supported response shapes", () => {
  const schema = z
    .object({
      type: z.union([z.literal("VideoObject"), z.array(z.string())]),
    })
    .passthrough();
  assert.deepEqual(schema.parse({ type: ["VideoObject"], custom: 1 }), {
    type: ["VideoObject"],
    custom: 1,
  });
  assert.equal(schema.safeParse({ type: 4 }).success, false);
});
