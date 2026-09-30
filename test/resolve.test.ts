/**
 * The ladder. Four properties matter:
 *
 *   1. the order is pool -> sxyprn -> eporner open
 *   2. an error in one rung lets the next run
 *   3. a known-dead URL is never written back
 *   4. `confidence` is the winner's IDENTITY TIER, and `low` means tier 0 -
 *      a winner chosen on views alone, which is the decoy path
 *
 * Plus the two things this change had to stop doing: a performer-less scene is
 * now ELIGIBLE, and the deferred lanes stay inert because `matcher` is an
 * explicit scope statement, not a data-derived check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScene, resolveLinks } from "../src/tubes/resolve.ts";
import { makeScene } from "./helpers.ts";
import type { PoolMatch } from "../src/tubes/eporner-pool.ts";

const now = new Date("2026-03-10T00:00:00Z");

const poolMatch = (over: Partial<PoolMatch> = {}): PoolMatch => ({
  url: "https://www.eporner.com/video-pool/",
  embedUrl: "https://www.eporner.com/embed/pool/",
  videoId: "pool",
  uploader: "Vovick17",
  title: "Marfe compilation 0304",
  identityTier: 1,
  lagDays: 1,
  candidatesConsidered: 3,
  durationPassed: 2,
  hydrated: 1,
  rejectedByDate: 0,
  unknownDate: 0,
  hydrationCapped: false,
  rejected: null,
  ...over,
});

/** A pool rung that ran and found nothing, distinguished by WHY. */
const poolMiss = (over: Partial<PoolMatch> = {}): PoolMatch =>
  poolMatch({ url: "", embedUrl: "", videoId: "", title: "", rejected: "date", ...over });

const sxyprnHit = (
  over: Partial<{ url: string; identityTier: 0 | 1 | 2 | 3; lagDays: number | null }> = {},
) => ({
  url: "https://sxyprn.com/post/6ab1a9bec8445.html",
  identityTier: 2 as const,
  lagDays: 0 as number | null,
  ...over,
});

const scene = makeScene({ id: "test:1", title: "Marfe takes it deep", performers: ["Marfe"] });

test("rung 1 (the trusted pool) wins when it matches", async () => {
  const result = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    poolLookup: async () => poolMatch(),
    sxyprnLookup: async () => [sxyprnHit()],
    openLookup: async () => [],
  });
  assert.equal(result.matched, true);
  assert.equal(result.rung, "eporner-pool");
  assert.equal(result.scene.videoUrls[0]!.source, "eporner-pool");
  // Tier 1 is a real match: the trusted pool's retitles only carry first names.
  assert.equal(result.scene.videoMatching?.confidence, "high");
  assert.equal(result.tier, 1);
});

test("confidence is the identity tier: only tier 0 reads low", async () => {
  for (const [tier, expected] of [
    [0, "low"],
    [1, "high"],
    [2, "high"],
    [3, "high"],
  ] as const) {
    const result = await resolveScene(scene, {
      matcher: "sxyprn+eporner",
      creatorStudio: false,
      now,
      poolLookup: async () => poolMatch({ identityTier: tier }),
      sxyprnLookup: null,
      openLookup: null,
    });
    assert.equal(result.scene.videoMatching?.confidence, expected, `tier ${tier}`);
    assert.equal(result.tier, tier, `tier ${tier} is reported for the histogram`);
  }
});

test("a winner with no identity evidence at all is the decoy path, and is flagged", async () => {
  // Nothing in the title names the performer. It won on views, so it is the
  // one class of match a human has to eyeball - and `low` is how it is found.
  const result = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    poolLookup: async () => poolMatch({ identityTier: 0, title: "unrelated clip", lagDays: 2 }),
    sxyprnLookup: null,
    openLookup: null,
  });
  assert.equal(result.matched, true);
  assert.equal(result.scene.videoMatching?.confidence, "low");
  assert.equal(result.tier, 0);
});

test("rung 2 runs when the pool misses, rung 3 when sxyprn errors", async () => {
  const missed = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    poolLookup: async () => poolMiss(),
    sxyprnLookup: async () => [sxyprnHit()],
    openLookup: async () => [],
  });
  assert.equal(missed.rung, "sxyprn");
  assert.equal(missed.scene.videoUrls[0]!.source, "sxyprn");

  const fellThrough = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    poolLookup: async () => poolMiss(),
    sxyprnLookup: async () => {
      throw new Error("sxyprn search unavailable");
    },
    openLookup: async () => [
      {
        video: {
          id: "open1",
          url: "https://www.eporner.com/video-open/",
          embed: "https://www.eporner.com/embed/open/",
          length_sec: 600,
          title: "Marfe takes it deep",
          added: "2026-03-05 10:00:00",
        },
        identityTier: 2,
      },
    ],
  });
  assert.equal(fellThrough.rung, "eporner-open");
  assert.equal(fellThrough.scene.videoUrls[0]!.source, "eporner");
  assert.equal(fellThrough.tier, 2, "rung 3 reports its own tier, it is not assumed");
});

test("a pool rung that rejected on the date is counted, not silently dropped", async () => {
  // The failure mode the rejection counts exist for: a rung that rejects
  // everything looks identical to a rung that found nothing, unless it says so.
  const rejections = {
    attempted: 0,
    noMatch: 0,
    errored: 0,
    date: 0,
    unknownDate: 0,
    duration: 0,
  };
  await resolveScene(
    scene,
    {
      matcher: "sxyprn+eporner",
      creatorStudio: false,
      now,
      poolLookup: async () => poolMiss({ rejectedByDate: 4, unknownDate: 2 }),
      sxyprnLookup: null,
      // Rungs 2 and 3 disabled, so the counts below are the POOL's alone.
      openLookup: null,
    },
    rejections,
  );
  assert.equal(rejections.date, 4);
  assert.equal(rejections.unknownDate, 2, "an undatable candidate is counted, never passed");
  assert.equal(rejections.noMatch, 1);
  assert.equal(rejections.attempted, 1, "only the pool rung was configured");
});

test("a known-dead URL is never re-added", async () => {
  const withDead = makeScene({
    id: "test:2",
    title: "Marfe takes it deep",
    performers: ["Marfe"],
    deadVideoUrls: [
      {
        source: "eporner-pool",
        url: "https://www.eporner.com/video-pool/",
        deadAt: "2026-03-01T00:00:00Z",
        deadReason: "gone",
      },
    ],
  });
  const result = await resolveScene(withDead, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    poolLookup: async () => poolMatch(),
    sxyprnLookup: null,
    openLookup: null,
  });
  assert.equal(result.matched, false);
  assert.equal(result.rung, null);
  // Still checked, so the read model can report when the scene was last looked at.
  assert.equal(result.scene.videoCheckedAt, now.toISOString());
  // A dead URL is NOT a no-match: the rung did answer, it just could not be
  // used. Writing it to `deadVideoUrls` again is `reverify`'s job, not this one's.
  assert.deepEqual(result.scene.deadVideoUrls, withDead.deadVideoUrls);
});

test("a metadata-only lane never enters the ladder", async () => {
  let called = false;
  const result = await resolveScene(scene, {
    matcher: null,
    creatorStudio: false,
    now,
    poolLookup: async () => {
      called = true;
      return null;
    },
    sxyprnLookup: null,
    openLookup: null,
  });
  assert.equal(called, false);
  assert.equal(result.changed, false);
  assert.equal(result.rung, "none");
});

test("a scene with a live link and one without a duration are left alone", async () => {
  const linked = makeScene({
    id: "test:3",
    durationSec: 600,
    videoUrls: [
      {
        source: "eporner",
        url: "https://www.eporner.com/video-x/",
        verifiedAt: "2026-03-01T00:00:00Z",
        verifyFailures: 0,
      },
    ],
  });
  const kept = await resolveScene(linked, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    poolLookup: async () => poolMatch(),
    sxyprnLookup: null,
    openLookup: null,
  });
  assert.equal(kept.changed, false);

  const durationless = makeScene({ id: "test:4", durationSec: null });
  const skipped = await resolveScene(durationless, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    poolLookup: async () => poolMatch(),
    sxyprnLookup: null,
    openLookup: null,
  });
  assert.equal(skipped.changed, false);
  assert.equal(skipped.matched, false);
});

test("a performer-less scene IS eligible, and can still be linked", async () => {
  // INVERTED from the old gate. Performer data is genuinely spotty upstream, and
  // requiring it meant such a scene could never be linked at all - a real gap,
  // not a safety property.
  const noPerformers = makeScene({ id: "test:5", title: "Marfe takes it deep", performers: [] });
  let called = false;
  const result = await resolveScene(noPerformers, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    poolLookup: async () => {
      called = true;
      return poolMatch({ identityTier: 3, title: "Marfe takes it deep" });
    },
    sxyprnLookup: null,
    openLookup: null,
  });
  assert.equal(called, true, "the pool rung was actually consulted");
  assert.equal(result.matched, true);
  assert.equal(result.scene.videoMatching?.confidence, "high");
});

test("resolveLinks keeps ineligible scenes out of the queue and preserves order", async () => {
  const scenes = [
    scene,
    makeScene({ id: "test:9", durationSec: null }),
    makeScene({ id: "test:10", title: "Marfe takes it deep", performers: ["Marfe"] }),
    // Performer-less but duration-bearing: now ELIGIBLE, so the count is 3.
    makeScene({ id: "test:11", title: "Marfe takes it deep", performers: [] }),
  ];
  const result = await resolveLinks({
    scenes,
    now,
    mapWithConcurrency: async (items, task) =>
      Promise.all(items.map((item, index) => task(item, index))),
    matcherFor: () => ({ matcher: "sxyprn+eporner", creatorStudio: false }),
    poolLookup: async () => poolMatch(),
    sxyprnLookup: null,
    openLookup: null,
  });
  assert.equal(result.considered, 3);
  assert.equal(result.matched, 3);
  assert.deepEqual(
    result.scenes.map((entry) => entry.id),
    ["test:1", "test:9", "test:10", "test:11"],
  );
  // The tier histogram is collected from real winners, not recovered from the
  // stored confidence, so tiers 1/2/3 stay distinguishable.
  assert.deepEqual(result.tiers, [1, 1, 1]);
});

test("a deferred lane produces zero links and never enters the ladder", async () => {
  // A scope guard, not a target. `matcher: null` is an explicit statement that
  // the lane is deliberately not linked; deriving it from data instead would
  // silently start linking a deferred lane the day its adapter improves.
  let called = false;
  const result = await resolveLinks({
    scenes: [makeScene({ id: "madouqu:1", durationSec: 900, title: "anything" })],
    now,
    mapWithConcurrency: async (items, task) =>
      Promise.all(items.map((item, index) => task(item, index))),
    matcherFor: () => ({ matcher: null, creatorStudio: false }),
    poolLookup: async () => {
      called = true;
      return poolMatch();
    },
    sxyprnLookup: null,
    openLookup: null,
  });
  assert.equal(called, false);
  assert.equal(result.considered, 0);
  assert.equal(result.matched, 0);
});

test("limit bounds the queue, and 0 is a limit rather than no limit", async () => {
  // `limit ? eligible.slice(0, limit) : eligible` read 0 as "unbounded" and
  // passed a negative straight to `slice`, which counts from the END - so -1
  // resolved the LAST scene instead of none. `undefined` is the only unbounded
  // value.
  const scenes = Array.from({ length: 4 }, (_, index) =>
    makeScene({ id: `test:${index}`, durationSec: 900, title: `Scene ${index}` }),
  );
  const options = {
    now,
    mapWithConcurrency: async <T, R>(items: T[], task: (item: T, index: number) => Promise<R>) =>
      Promise.all(items.map((item, index) => task(item, index))),
    matcherFor: () => ({ matcher: "sxyprn", creatorStudio: false }),
    poolLookup: null,
    sxyprnLookup: async () => [sxyprnHit()],
    openLookup: null,
  };

  assert.equal(
    (await resolveLinks({ scenes, ...options })).considered,
    4,
    "undefined is unbounded",
  );
  assert.equal((await resolveLinks({ scenes, ...options, limit: 2 })).considered, 2);
  assert.equal(
    (await resolveLinks({ scenes, ...options, limit: 0 })).considered,
    0,
    "0 means none, not all",
  );
  assert.equal(
    (await resolveLinks({ scenes, ...options, limit: -1 })).considered,
    0,
    "never from the end",
  );
  assert.equal(
    (await resolveLinks({ scenes, ...options, limit: 99 })).considered,
    4,
    "clamped by the queue",
  );
});
