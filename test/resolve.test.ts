/**
 * The ladder. Four properties matter:
 *
 *   1. eporner and sxyprn compete under one shared rank
 *   2. an error from either source does not block the other
 *   3. a known-dead URL is never written back
 *   4. `confidence` is the winner's IDENTITY TIER, and `low` means tier 0 -
 *      a winner with no identity evidence, which is the decoy path
 *
 * Plus the two things this change had to stop doing: a performer-less scene is
 * now ELIGIBLE, and the deferred lanes stay inert because `matcher` is an
 * explicit scope statement, not a data-derived check.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOW_CONFIDENCE_RULE,
  resolveScene as resolveSceneImpl,
  resolveLinks as resolveLinksImpl,
  type ResolveDeps,
  type ResolveLinksOptions,
} from "../src/tubes/resolve.ts";
import { makeScene } from "./helpers.ts";
import type { MatchScene } from "../src/tubes/types.ts";
import { poolResultAsEpornerMatches, type LegacyPoolMatch } from "./helpers.ts";

const now = new Date("2026-03-10T00:00:00Z");

const poolMatch = (over: Partial<LegacyPoolMatch> = {}): LegacyPoolMatch => ({
  url: "https://www.eporner.com/video-pool/",
  embedUrl: "https://www.eporner.com/embed/pool/",
  videoId: "eporner",
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
  omittedCandidates: 0,
  fallbackCandidates: [],
  rejected: null,
  ...over,
});

type LegacyLookup = ((scene: MatchScene, now: Date) => Promise<LegacyPoolMatch | null>) | null;

function resolveScene(
  scene: ReturnType<typeof makeScene>,
  deps: Omit<ResolveDeps, "epornerLookup"> & { epornerLookup: LegacyLookup },
  rejections?: Parameters<typeof resolveSceneImpl>[2],
) {
  return resolveSceneImpl(
    scene,
    {
      ...deps,
      epornerLookup: deps.epornerLookup
        ? async (matchScene) =>
            poolResultAsEpornerMatches(await deps.epornerLookup!(matchScene, now), matchScene)
        : null,
    },
    rejections,
  );
}

function resolveLinks(
  options: Omit<ResolveLinksOptions, "epornerLookup"> & { epornerLookup: LegacyLookup },
) {
  return resolveLinksImpl({
    ...options,
    epornerLookup: options.epornerLookup
      ? async (matchScene) =>
          poolResultAsEpornerMatches(await options.epornerLookup!(matchScene, now), matchScene)
      : null,
  });
}

/** A pool rung that ran and found nothing, distinguished by WHY. */
const poolMiss = (over: Partial<LegacyPoolMatch> = {}): LegacyPoolMatch =>
  poolMatch({ url: "", embedUrl: "", videoId: "", title: "", rejected: "date", ...over });

const sxyprnHit = (
  over: Partial<{
    url: string;
    identityTier: 0 | 1 | 2 | 3;
    title: string;
    duration: number;
    views: number | null;
  }> = {},
) => ({
  url: "https://sxyprn.com/post/6ab1a9bec8445.html",
  identityTier: 2 as const,
  title: "Marfe takes it deep",
  duration: 900,
  views: 1200,
  ...over,
});

const scene = makeScene({ id: "test:1", title: "Marfe takes it deep", performers: ["Marfe"] });

test("the shared rank selects the stronger identity tier across both sources", async () => {
  const result = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    epornerLookup: async () => poolMatch(),
    sxyprnLookup: async () => [sxyprnHit()],
  });
  assert.equal(result.matched, true);
  assert.equal(result.rung, "sxyprn");
  assert.equal(result.scene.videoUrls[0]!.source, "sxyprn");
  // Tier 1 is a real match: source priority does not override the shared identity tier.
  assert.equal(result.scene.videoMatching?.confidence, "high");
  assert.equal(result.tier, 2);
});

test("Eporner can win when its candidate ranks higher; the provider does not decide", async () => {
  const result = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    epornerLookup: async () => poolMatch({ identityTier: 3, title: "Marfe takes it deep" }),
    sxyprnLookup: async () => [
      sxyprnHit({ identityTier: 1, title: "Marfe compilation", views: 9_000_000 }),
    ],
  });
  assert.equal(result.rung, "eporner");
  assert.equal(result.scene.videoUrls[0]?.source, "eporner");
  assert.equal(result.tier, 3);
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
      epornerLookup: async () => poolMatch({ identityTier: tier }),
      sxyprnLookup: null,
    });
    assert.equal(result.scene.videoMatching?.confidence, expected, `tier ${tier}`);
    assert.equal(result.tier, tier, `tier ${tier} is reported for the histogram`);
  }
});

test("without a named match, the highest-view survivor across both tubes is linked low", async () => {
  // The low-confidence choice is deliberately made only after both tubes have
  // declined to produce a named match. The pool has a date+duration survivor
  // with 900 views; sxyprn has one with 12,000, so the survivor from the second
  // tube wins the cross-tube comparison.
  const result = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    epornerLookup: async () =>
      poolMatch({
        url: "",
        rejected: "none",
        fallbackCandidates: [
          {
            title: "unrelated pool clip",
            duration: 900,
            added: "2026-03-05T10:00:00Z",
            views: 900,
            url: "https://www.eporner.com/video-pool-low/",
          },
        ],
      }),
    sxyprnLookup: async () => [
      sxyprnHit({
        identityTier: 0,
        title: "unrelated sxyprn clip",
        duration: 900,
        views: 12_000,
        url: "https://sxyprn.com/post/6ab1a9bec8446.html",
      }),
    ],
  });
  assert.equal(result.matched, true);
  assert.equal(result.rung, "fallback");
  assert.equal(result.scene.videoMatching?.confidence, "low");
  assert.equal(result.scene.videoMatching?.rule, LOW_CONFIDENCE_RULE);
  assert.equal(result.scene.videoUrls[0]?.source, "sxyprn");
  assert.equal(result.scene.videoUrls[0]?.url, "https://sxyprn.com/post/6ab1a9bec8446.html");
  assert.equal(result.tier, 0);
});

test("an identity-backed Sxyprn result beats a more-viewed Eporner fallback", async () => {
  const result = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    epornerLookup: async () =>
      poolMatch({
        url: "",
        rejected: "none",
        fallbackCandidates: [
          {
            title: "unrelated viral clip",
            duration: 900,
            added: "2026-03-05T10:00:00Z",
            views: 10_000_000,
            url: "https://www.eporner.com/video-viral/",
          },
        ],
      }),
    sxyprnLookup: async () => [
      sxyprnHit({
        identityTier: 1,
        title: "Marfe compilation",
        duration: 900,
        views: 1,
      }),
    ],
  });
  assert.equal(result.rung, "sxyprn");
  assert.equal(result.scene.videoMatching?.confidence, "high");
  assert.equal(result.scene.videoUrls[0]?.source, "sxyprn");
  assert.equal(result.tier, 1);
});

test("both sources contribute independently, including when one source errors", async () => {
  const missed = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    epornerLookup: async () => poolMiss(),
    sxyprnLookup: async () => [sxyprnHit()],
  });
  assert.equal(missed.rung, "sxyprn");
  assert.equal(missed.scene.videoUrls[0]!.source, "sxyprn");

  // An error is not a no-match. Since Eporner returned no candidates and
  // Sxyprn could not answer, the scene stays unlinked.
  const errored = await resolveScene(scene, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    epornerLookup: async () => poolMiss(),
    sxyprnLookup: async () => {
      throw new Error("sxyprn search unavailable");
    },
  });
  assert.equal(errored.matched, false);
  assert.equal(errored.rung, null);
  assert.deepEqual(errored.scene.videoUrls, []);
  // Still stamped, so the read model can say when it was last looked at.
  assert.equal(errored.scene.videoCheckedAt, now.toISOString());
});

test("a known-dead URL is never re-added", async () => {
  const withDead = makeScene({
    id: "test:2",
    title: "Marfe takes it deep",
    performers: ["Marfe"],
    deadVideoUrls: [
      {
        source: "eporner",
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
    epornerLookup: async () => poolMatch(),
    sxyprnLookup: null,
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
    epornerLookup: async () => {
      called = true;
      return null;
    },
    sxyprnLookup: null,
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
    epornerLookup: async () => poolMatch(),
    sxyprnLookup: null,
  });
  assert.equal(kept.changed, false);

  const durationless = makeScene({ id: "test:4", durationSec: null });
  const skipped = await resolveScene(durationless, {
    matcher: "sxyprn+eporner",
    creatorStudio: false,
    now,
    epornerLookup: async () => poolMatch(),
    sxyprnLookup: null,
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
    epornerLookup: async () => {
      called = true;
      return poolMatch({ identityTier: 3, title: "Marfe takes it deep" });
    },
    sxyprnLookup: null,
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
    epornerLookup: async () => poolMatch(),
    sxyprnLookup: null,
  });
  assert.equal(result.considered, 3);
  assert.equal(result.matched, 3);
  assert.deepEqual(
    result.scenes.map((entry) => entry.id),
    ["test:1", "test:9", "test:10", "test:11"],
  );
  // The tier histogram records the shared source rank of each winner.
  assert.deepEqual(result.winners, [
    { rung: "eporner", tier: 1 },
    { rung: "eporner", tier: 1 },
    { rung: "eporner", tier: 1 },
  ]);
});

test("each winner is recorded with the rung that produced it, guesses included", async () => {
  // The run ledger used to store only the identity tier, so a named match and the
  // terminal fallback's guess were the same observation from the ledger's side.
  // That is the number that makes "69 matched" unreadable: most of it can be
  // guesses, and nothing on the row says so.
  const scenes = [
    makeScene({ id: "test:named-pool", title: "Marfe takes it deep", performers: ["Marfe"] }),
    makeScene({ id: "test:named-slow", title: "Marfe takes it deep", performers: ["Marfe"] }),
    makeScene({ id: "test:guess", title: "Marfe takes it deep", performers: ["Marfe"] }),
    makeScene({ id: "test:unlinked", title: "Marfe takes it deep", performers: ["Marfe"] }),
  ];
  const [poolNamed, , guess, unlinked] = scenes.map((entry) => entry.id) as [
    string,
    string,
    string,
    string,
  ];
  const result = await resolveLinks({
    scenes,
    now,
    mapWithConcurrency: async (items, task) =>
      Promise.all(items.map((item, index) => task(item, index))),
    matcherFor: () => ({ matcher: "sxyprn+eporner", creatorStudio: false }),
    epornerLookup: async (candidate) =>
      candidate.id === poolNamed ? poolMatch() : poolMiss({ fallbackCandidates: [] }),
    // Both sources are considered for each scene. Eporner wins one named scene,
    // Sxyprn wins another, and the third only has an unnamed fallback.
    sxyprnLookup: async (candidate) => {
      const slug =
        candidate.id === poolNamed
          ? "0000000000001"
          : candidate.id === guess
            ? "0000000000002"
            : "0000000000003";
      const url = `https://sxyprn.com/post/${slug}.html`;
      if (candidate.id === unlinked) return [];
      if (candidate.id === poolNamed || candidate.id === guess)
        return [sxyprnHit({ identityTier: 0, title: "unrelated clip", url })];
      return [sxyprnHit({ url })];
    },
  });

  assert.deepEqual(result.winners, [
    { rung: "eporner", tier: 1 },
    { rung: "sxyprn", tier: 2 },
    { rung: "fallback", tier: 0 },
  ]);
  assert.equal(result.matched, 3, "the unlinked scene contributes no winner to record");
});

test("a deferred lane produces zero links and never enters the ladder", async () => {
  // A scope guard, not a target. `matcher: null` is an explicit statement that
  // the lane is deliberately not linked; deriving it from data instead would
  // silently start linking a deferred lane the day its adapter improves.
  let called = false;
  const result = await resolveLinks({
    scenes: [
      makeScene({
        id: "madouqu:1",
        durationSec: 900,
        title: "anything",
        performers: ["空空子"],
      }),
    ],
    now,
    mapWithConcurrency: async (items, task) =>
      Promise.all(items.map((item, index) => task(item, index))),
    matcherFor: () => ({ matcher: null, creatorStudio: false }),
    epornerLookup: async () => {
      called = true;
      return poolMatch();
    },
    sxyprnLookup: null,
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
    epornerLookup: null,
    sxyprnLookup: async () => [sxyprnHit()],
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

test("onProgress reports the queue once, then one step per completion, in order", async () => {
  // The meter is driven from inside a CONCURRENT map, so the only safe progress
  // signal is a running completion count. Deriving it from a result index would
  // make the bar jump about as tasks interleave.
  const scenes = Array.from({ length: 4 }, (_, index) =>
    makeScene({ id: `test:${index}`, durationSec: 900, title: `Scene ${index}` }),
  );
  const seen: Array<{ done: number; total: number; matched: number }> = [];
  const result = await resolveLinks({
    scenes,
    now,
    mapWithConcurrency: async (items, task) =>
      Promise.all(items.map((item, index) => task(item, index))),
    matcherFor: () => ({ matcher: "sxyprn", creatorStudio: false }),
    epornerLookup: null,
    // The first two resolve and the rest miss, so `matched` is asserted
    // against a counter that is genuinely mid-flight rather than all-or-nothing.
    sxyprnLookup: async (candidate) =>
      candidate.id === "test:0" || candidate.id === "test:1"
        ? [sxyprnHit({ title: candidate.title })]
        : [],
    onProgress: (done, total, matched) => seen.push({ done, total, matched }),
  });
  assert.equal(result.considered, 4);
  // These two start in index order, so the two matches are the first two to
  // finish: the running `matched` reaches 2 and then holds while the misses
  // complete. A counter derived from a result index could not do this.
  assert.deepEqual(seen, [
    { done: 0, total: 4, matched: 0 },
    { done: 1, total: 4, matched: 1 },
    { done: 2, total: 4, matched: 2 },
    { done: 3, total: 4, matched: 2 },
    { done: 4, total: 4, matched: 2 },
  ]);
  assert.equal(seen.at(-1)?.matched, result.matched, "the running total agrees with the result");
});

test("onProgress reports the CAPPED queue, so a bounded run still reaches 100%", async () => {
  const scenes = Array.from({ length: 6 }, (_, index) =>
    makeScene({ id: `test:${index}`, durationSec: 900, title: `Scene ${index}` }),
  );
  const totals = new Set<number>();
  await resolveLinks({
    scenes,
    now,
    mapWithConcurrency: async (items, task) =>
      Promise.all(items.map((item, index) => task(item, index))),
    matcherFor: () => ({ matcher: "sxyprn", creatorStudio: false }),
    epornerLookup: null,
    sxyprnLookup: async () => [],
    limit: 2,
    onProgress: (_done, total) => totals.add(total),
  });
  assert.deepEqual([...totals], [2], "the cap is the denominator throughout");
});

test("an empty queue still reports, as a real zero", async () => {
  // A pass that checked nothing has to be distinguishable from a pass that never
  // ran - otherwise the meter waits on a total that is never announced.
  const seen: Array<[number, number]> = [];
  await resolveLinks({
    scenes: [makeScene({ id: "test:1", durationSec: null })],
    now,
    mapWithConcurrency: async (items, task) =>
      Promise.all(items.map((item, index) => task(item, index))),
    matcherFor: () => ({ matcher: "sxyprn", creatorStudio: false }),
    epornerLookup: null,
    sxyprnLookup: null,
    onProgress: (done, total) => seen.push([done, total]),
  });
  assert.deepEqual(seen, [[0, 0]]);
});
