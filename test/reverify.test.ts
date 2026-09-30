import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createLinkVerifier,
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
  const result = await reverifyLinks([scene], {
    verify: async () => ({ status: "live" as const }),
    now,
  });
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
    makeScene({
      id: "test:a",
      videoUrls: [
        link({ url: "https://www.eporner.com/video-a/", verifiedAt: "2026-03-05T00:00:00Z" }),
      ],
    }),
    makeScene({
      id: "test:b",
      videoUrls: [
        link({ url: "https://www.eporner.com/video-b/", verifiedAt: "2026-03-01T00:00:00Z" }),
      ],
    }),
    makeScene({
      id: "test:c",
      videoUrls: [
        link({ url: "https://www.eporner.com/video-c/", verifiedAt: "2026-03-03T00:00:00Z" }),
      ],
    }),
  ];
  const slice = selectReverifySlice(scenes, 2);
  assert.deepEqual(
    slice.map((entry) => entry.link.url),
    ["https://www.eporner.com/video-b/", "https://www.eporner.com/video-c/"],
  );
});
test("a fatal-filtered scene with no NEW dead link still re-enters resolution", async () => {
  // The `fatal` filter empties the live set without adding to `deadVideoUrls`,
  // so gating the `videoCheckedAt` reset on "did anything die" left the scene
  // marked as checked - and it never re-entered normal resolution again.
  const scene = makeScene({
    id: "test:1",
    videoUrls: [link()],
    videoCheckedAt: "2026-03-05T00:00:00Z",
    videoMatching: {
      lane: "eporner",
      matchedAt: "2026-03-05T00:00:00Z",
      rule: "duration+window",
      confidence: "high",
    },
  });
  const verify = async () => ({ status: "live" as const });
  const result = await reverifyLinks([scene], {
    verify,
    now: new Date("2026-03-10T00:00:00Z"),
    fatal: () => true,
  });
  const after = result.scenes[0]!;
  assert.equal(after.videoUrls.length, 0, "the fatal link is gone");
  assert.equal(after.deadVideoUrls.length, 0, "and nothing was newly struck");
  assert.equal(after.videoCheckedAt, null, "so the scene must re-enter resolution");
});

test("a scene that keeps a live link keeps its checked watermark", async () => {
  const scene = makeScene({
    id: "test:1",
    videoUrls: [link()],
    videoCheckedAt: "2026-03-05T00:00:00Z",
  });
  const result = await reverifyLinks([scene], {
    verify: async () => ({ status: "live" as const }),
    now: new Date("2026-03-10T00:00:00Z"),
    fatal: (candidate) => candidate.url === "https://www.eporner.com/video-zzz/",
  });
  assert.equal(result.scenes[0]!.videoCheckedAt, "2026-03-05T00:00:00Z");
});

test("an eporner 200 with a non-JSON body is an anti-bot wall, not a deletion", async () => {
  // eporner's edge answers a challenge with HTTP 200 and an HTML interstitial.
  // Reading that as the API's empty-array "no such video" strikes a live link,
  // and two strikes move it into `deadVideoUrls` permanently.
  const html = { status: 200, headers: new Headers({ "content-type": "text/html" }) };
  const verify = createLinkVerifier({
    fetcher: {
      fetch: async () => new Response("<html>checking your browser</html>", html),
      text: async () => "",
      json: async <T>() => ({}) as T,
    },
  });
  const outcome = await verify(link());
  assert.equal(outcome.status, "inconclusive");
  assert.match(outcome.reason ?? "", /anti-bot/);
});

test("an eporner 200 with real JSON is still authoritative", async () => {
  const jsonHeaders = { status: 200, headers: new Headers({ "content-type": "application/json" }) };
  const gone = createLinkVerifier({
    fetcher: {
      fetch: async () => new Response("[]", jsonHeaders),
      text: async () => "",
      json: async <T>() => [] as unknown as T,
    },
  });
  assert.equal((await gone(link())).status, "dead", "an empty JSON array is the API's own answer");

  const present = createLinkVerifier({
    fetcher: {
      fetch: async () => new Response('[{"id":"abc"}]', jsonHeaders),
      text: async () => "",
      json: async <T>() => [{ id: "abc" }] as unknown as T,
    },
  });
  assert.equal((await present(link())).status, "live");
});

test("onProgress reports the slice before the loop, so an empty pass is a real zero", async () => {
  // A re-verify pass over nothing has to be distinguishable from a pass that
  // never ran, or the meter waits on a total that is never announced.
  const seen: Array<[number, number]> = [];
  await reverifyLinks([makeScene({ id: "test:1", videoUrls: [] })], {
    verify: async () => ({ status: "live" as const }),
    now: new Date("2026-03-10T00:00:00Z"),
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen, [[0, 0]]);
});

test("onProgress advances once per link, and a link that throws still counts", async () => {
  const now = new Date("2026-03-10T00:00:00Z");
  const scenes = ["a", "b", "c"].map((id) =>
    makeScene({
      id: `test:${id}`,
      videoUrls: [link({ url: `https://www.eporner.com/video-${id}/` })],
    }),
  );
  const seen: Array<[number, number]> = [];
  await reverifyLinks(scenes, {
    verify: async (target) => {
      if (target.url.endsWith("/b")) throw new Error("network flaked");
      return { status: "live" as const };
    },
    now,
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen, [
    [0, 3],
    [1, 3],
    [2, 3],
    [3, 3],
  ]);
});
