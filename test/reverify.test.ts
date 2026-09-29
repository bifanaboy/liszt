import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reverifyLinks,
  selectReverifySlice,
  REVERIFY_STRIKE_LIMIT,
} from "../src/tubes/reverify.ts";
import { makeScene } from "./helpers.ts";
import type { VideoLink } from "../src/core/schema.ts";

const link = (over: Partial<VideoLink> = {}): VideoLink => ({
  source: "eporner",
  url: "https://www.eporner.com/video-abc/",
  verifiedAt: "2026-03-01T00:00:00Z",
  verifyFailures: 0,
  ...over,
});

test("a definitive failure strikes once, then moves the link to dead", async () => {
  const scene = makeScene({ id: "test:1", videoUrls: [link()] });
  const now = new Date("2026-03-10T00:00:00Z");
  const verify = async () => ({ status: "dead" as const, reason: "gone" });

  const first = await reverifyLinks([scene], { verify, now });
  const afterFirst = first.scenes[0]!;
  assert.equal(afterFirst.videoUrls.length, 1);
  assert.equal(afterFirst.videoUrls[0]!.verifyFailures, 1);
  assert.equal(afterFirst.deadVideoUrls.length, 0);

  const second = await reverifyLinks([afterFirst], { verify, now });
  const afterSecond = second.scenes[0]!;
  assert.equal(afterSecond.videoUrls.length, 0);
  assert.equal(afterSecond.deadVideoUrls.length, 1);
  assert.equal(afterSecond.deadVideoUrls[0]!.deadReason, "gone");
  // The last live link died, so the scene re-enters normal resolution.
  assert.equal(afterSecond.videoCheckedAt, null);
  assert.equal(REVERIFY_STRIKE_LIMIT, 2);
});

test("a live result refreshes verifiedAt and clears strikes", async () => {
  const scene = makeScene({ id: "test:2", videoUrls: [link({ verifyFailures: 1 })] });
  const now = new Date("2026-03-10T00:00:00Z");
  const result = await reverifyLinks([scene], { verify: async () => ({ status: "live" as const }), now });
  assert.equal(result.scenes[0]!.videoUrls[0]!.verifyFailures, 0);
  assert.equal(result.scenes[0]!.videoUrls[0]!.verifiedAt, now.toISOString());
});

test("an inconclusive result leaves the link untouched", async () => {
  const scene = makeScene({ id: "test:3", videoUrls: [link({ verifyFailures: 1 })] });
  const now = new Date("2026-03-10T00:00:00Z");
  const result = await reverifyLinks([scene], {
    verify: async () => ({ status: "inconclusive" as const }),
    now,
  });
  assert.equal(result.scenes[0]!.videoUrls[0]!.verifyFailures, 1);
  assert.equal(result.scenes[0]!.videoUrls[0]!.verifiedAt, "2026-03-01T00:00:00Z");
});

test("the re-verify slice is the stalest links first, capped at the limit", () => {
  const scenes = [
    makeScene({ id: "test:a", videoUrls: [link({ url: "https://www.eporner.com/video-a/", verifiedAt: "2026-03-05T00:00:00Z" })] }),
    makeScene({ id: "test:b", videoUrls: [link({ url: "https://www.eporner.com/video-b/", verifiedAt: "2026-03-01T00:00:00Z" })] }),
    makeScene({ id: "test:c", videoUrls: [link({ url: "https://www.eporner.com/video-c/", verifiedAt: "2026-03-03T00:00:00Z" })] }),
  ];
  const slice = selectReverifySlice(scenes, 2);
  assert.deepEqual(
    slice.map((entry) => entry.link.url),
    ["https://www.eporner.com/video-b/", "https://www.eporner.com/video-c/"],
  );
});