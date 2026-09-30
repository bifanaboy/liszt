/**
 * The sxyprn rung, asserted at the client boundary.
 *
 * These are the properties the rung's correctness rests on, and each one is a
 * way the rung can be silently dead rather than loudly wrong:
 *
 *  - `details()` must forward `uploadDate` and `views`. It is the ONLY pass that
 *    carries a real date; drop either field at the boundary and the date half
 *    of the gate cannot run, so the rung admits nothing and reports no error.
 *  - a rendered `HH:MM:SS` duration must not be dropped for want of a numeric
 *    field, or the duration half fails the same way.
 *  - the circuit break must not be permanent. sxyprn answering 403 from a
 *    datacenter IP is a transient condition, and a break with no cooldown means
 *    a recovered source stays out of the ladder until a restart.
 *  - "the source is down" and "the gate rejected everything" are different
 *    answers, and only the first may abort the ladder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSxyprnClient, durationStringToSeconds } from "../src/tubes/sxyprn-client.ts";
import {
  createSxyprnLookup,
  type SxyprnCard,
  type SxyprnClient,
  type SxyprnDetail,
} from "../src/tubes/sxyprn.ts";
import { makeMatchScene, withDeadline } from "./helpers.ts";
import { mapWithConcurrency } from "../src/core/concurrency.ts";

const POST = "https://sxyprn.com/post/6ab1a9bec8445.html";
const OTHER = "https://sxyprn.com/post/6ab1a9bec8446.html";
const THIRD = "https://sxyprn.com/post/6ab1a9bec8447.html";

/** A package stub whose two methods the tests drive. */
function packageStub(
  over: {
    search?: () => Promise<{ videos?: Record<string, unknown>[] }>;
    details?: (input?: { url?: string }) => Promise<Record<string, unknown>>;
  } = {},
) {
  return {
    videos: {
      search: over.search ?? (async () => ({ videos: [] })),
      details: over.details ?? (async () => ({})),
    },
  };
}

test("details() forwards the two fields the gate cannot do without", async () => {
  const client = createSxyprnClient(
    packageStub({
      details: async () => ({
        url: POST,
        title: "Scene",
        durationSeconds: 1418,
        streamUrl: "https://sxyprn.com/stream.m3u8",
        uploadDate: "2026-03-05T10:00:00+00:00",
        views: "12,345",
        sizeBytes: 4096,
      }),
    }),
  );
  const detail = await client.videos.details({ url: POST });
  assert.equal(
    detail.uploadDate,
    "2026-03-05T10:00:00+00:00",
    "the detail pass is the only pass with a date",
  );
  assert.equal(detail.views, "12,345");
  assert.equal(detail.streamUrl, "https://sxyprn.com/stream.m3u8");
  assert.equal(detail.durationSeconds, 1418);
});

test("a rendered HH:MM:SS duration is parsed rather than dropped", async () => {
  // The package serves a duration string on some shapes and a number on
  // others. Reading only the number means the card carries no duration, the
  // duration half of the gate rejects it, and the rung reports "no match".
  assert.equal(durationStringToSeconds("23:38"), 1418);
  assert.equal(durationStringToSeconds("1:02:03"), 3723);
  assert.equal(durationStringToSeconds("bad"), null);
  assert.equal(durationStringToSeconds(""), null);
  assert.equal(durationStringToSeconds(undefined), null);
  assert.equal(durationStringToSeconds("23:xx"), null);

  const client = createSxyprnClient(
    packageStub({
      search: async () => ({ videos: [{ url: POST, title: "Scene", duration: "23:38" }] }),
      details: async () => ({ url: POST, title: "Scene", duration: "23:38" }),
    }),
  );
  const page = await client.videos.search("scene");
  assert.equal(page.videos?.[0]?.durationSeconds, 1418);
  const detail = await client.videos.details({ url: POST });
  assert.equal(detail.durationSeconds, 1418);
});

test("the circuit break reopens after a cooldown, and closes on the probe", async () => {
  let fail = true;
  let searchCalls = 0;
  const client = createSxyprnClient(
    packageStub({
      search: async () => {
        searchCalls += 1;
        if (fail) throw new Error("403 from Cloudflare");
        return { videos: [] };
      },
    }),
    { maxConsecutiveFailures: 1, cooldownMs: 50 },
  );

  await assert.rejects(client.videos.search("scene"), /403/);
  assert.equal(searchCalls, 1);

  // Still inside the cooldown: refused without a request, so a burst of scenes
  // cannot become a burst of attempts.
  await assert.rejects(client.videos.search("scene"), /403/);
  assert.equal(searchCalls, 1, "the break short-circuits before spending a request");

  // A recovered source rejoins the ladder on its own.
  fail = false;
  await new Promise((resolve) => setTimeout(resolve, 60));
  await client.videos.search("scene");
  assert.equal(searchCalls, 2, "one half-open probe was admitted and it succeeded");
  // And the break is closed, so a later failure starts counting from zero -
  // here from one again, and re-trips immediately.
  fail = true;
  await assert.rejects(client.videos.search("scene"), /403/);
  assert.equal(searchCalls, 3, "recovery reset the counter, so one failure re-breaks");
  await assert.rejects(client.videos.search("scene"), /403/);
  assert.equal(searchCalls, 3, "and the re-opened break short-circuits again");
});

test("a failed probe restarts the cooldown rather than retrying every call", async () => {
  let calls = 0;
  const client = createSxyprnClient(
    packageStub({
      search: async () => {
        calls += 1;
        throw new Error("still blocked");
      },
    }),
    { maxConsecutiveFailures: 1, cooldownMs: 50 },
  );
  await assert.rejects(client.videos.search("scene"));
  await new Promise((resolve) => setTimeout(resolve, 60));
  await assert.rejects(client.videos.search("scene"), /still blocked/);
  assert.equal(calls, 2, "the probe was spent");
  await assert.rejects(client.videos.search("scene"), /still blocked/);
  assert.equal(calls, 2, "and the break is back, cooldown restarted from the probe");
});

/** A client whose search returns cards and whose details return posts. */
function stubClient(over: {
  cards?: SxyprnCard[];
  details?: (url: string) => Promise<SxyprnDetail>;
}): SxyprnClient {
  return {
    videos: {
      search: async () => ({ videos: over.cards ?? [] }),
      details: async ({ url }) => {
        const detail = await (over.details ?? (async (u: string) => ({ url: u })))(url);
        return detail;
      },
    },
  };
}

const SCENE = makeMatchScene({
  id: "test:1",
  title: "Marfe takes it deep",
  performers: ["Marfe okkk"],
  releaseDate: "2026-03-04",
  durationSec: 1418,
});

test("a source that throws synchronously cannot wedge the breaker", async () => {
  // The call used to be started before the deadline wrapper was entered, so a
  // synchronous throw escaped uncounted - and because `guard()` had already
  // claimed the half-open probe, the breaker was left marked "probing" and
  // refused every later call. Only a restart recovered it.
  let hard = true;
  let calls = 0;
  const client = createSxyprnClient(
    {
      videos: {
        search: () => {
          calls += 1;
          if (hard) throw new Error("client construction failed");
          return Promise.resolve({ videos: [] });
        },
        details: async () => ({}),
      },
    },
    { maxConsecutiveFailures: 1, cooldownMs: 20 },
  );

  await assert.rejects(client.videos.search("scene"), /client construction failed/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(client.videos.search("scene"), /client construction failed/);
  assert.equal(calls, 2, "the second failure was the half-open probe");

  hard = false;
  await new Promise((resolve) => setTimeout(resolve, 30));
  await client.videos.search("scene");
  assert.equal(calls, 3, "and the breaker is not stuck with a claimed probe");
});

test("a post that clears the gate is admitted, and its evidence is recorded", async () => {
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [{ url: POST, title: "Marfe takes it deep", durationSeconds: 1418 }],
      details: async (url) => ({
        url,
        title: "Marfe takes it deep",
        durationSeconds: 1418,
        streamUrl: "https://sxyprn.com/stream.m3u8",
        uploadDate: "2026-03-05T10:00:00+00:00",
        views: 1200,
      }),
    }),
    dateWindowDays: 7,
  });
  const matches = await lookup(SCENE);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.url, POST);
  assert.equal(matches[0]?.lagDays, 1);
});

test("an unnamed date-and-duration survivor is returned with views for terminal fallback", async () => {
  // This post cannot be a high-confidence match: it names no performer. It
  // still clears the cheap filters and must remain available to the ladder's
  // cross-tube fallback, where its views are compared with the pool's
  // leftovers. Returning `[]` here would make sxyprn's useful near-miss
  // invisible even though the source supplied every field the fallback needs.
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [{ url: POST, title: "viral unrelated video", durationSeconds: 1418 }],
      details: async (url) => ({
        url,
        title: "viral unrelated video",
        durationSeconds: 1418,
        streamUrl: "https://sxyprn.com/stream.m3u8",
        uploadDate: "2026-03-05T10:00:00+00:00",
        views: "12,345",
      }),
    }),
    dateWindowDays: 7,
  });
  const candidates = await lookup(SCENE);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.identityTier, 0);
  assert.equal(candidates[0]?.views, "12,345");
  assert.equal(candidates[0]?.url, POST);
});

test("a blank search-card title still reaches detail verification", async () => {
  // The card pass is a duration shortlist, not an identity gate. Some cards do
  // not carry a usable title even though the post detail does; dropping them
  // before detail verification would lose both a possible named match and the
  // fallback survivor.
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [{ url: POST, title: "", durationSeconds: 1418, views: 5000 }],
      details: async (url) => ({
        url,
        title: "Marfe takes it deep",
        durationSeconds: 1418,
        streamUrl: "https://sxyprn.com/stream.m3u8",
        uploadDate: "2026-03-05T10:00:00+00:00",
        views: 5000,
      }),
    }),
    dateWindowDays: 7,
  });
  const candidates = await lookup(SCENE);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.identityTier, 3);
});

test("a blank detail title can still be a low-confidence survivor", async () => {
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [{ url: POST, title: "", durationSeconds: 1418 }],
      details: async (url) => ({
        url,
        title: "",
        durationSeconds: 1418,
        streamUrl: "https://sxyprn.com/stream.m3u8",
        uploadDate: "2026-03-05T10:00:00+00:00",
        views: 77,
      }),
    }),
    dateWindowDays: 7,
  });
  const candidates = await lookup(SCENE);
  assert.equal(candidates.length, 1, "date and duration are enough for a fallback survivor");
  assert.equal(candidates[0]?.identityTier, 0);
  assert.equal(candidates[0]?.views, 77);
});

test("a post the gate rejects is a miss, NOT a source outage", async () => {
  // The distinction the counter exists for: an answered post that failed the
  // gate must not abort the ladder, or a mis-tuned window reads as "sxyprn is
  // down" and every scene falls through to the rung below for the wrong reason.
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [{ url: POST, title: "Marfe takes it deep", durationSeconds: 1418 }],
      details: async (url) => ({
        url,
        title: "Marfe takes it deep",
        durationSeconds: 1418,
        streamUrl: "https://sxyprn.com/stream.m3u8",
        uploadDate: "2026-08-01T10:00:00+00:00",
      }),
    }),
    dateWindowDays: 7,
  });
  assert.deepEqual(await lookup(SCENE), []);
});

test("a post the source cannot answer at all IS a source outage", async () => {
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [{ url: POST, title: "Marfe takes it deep", durationSeconds: 1418 }],
      details: async () => {
        throw new Error("403");
      },
    }),
    dateWindowDays: 7,
  });
  await assert.rejects(lookup(SCENE), /sxyprn post verification unavailable/);
});

test("the detail pass fetches concurrently but verifies in rank order", async () => {
  let inFlight = 0;
  let peak = 0;
  const release: (() => void)[] = [];
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [
        { url: POST, title: "Marfe takes it deep", durationSeconds: 1418 },
        { url: OTHER, title: "Marfe takes it deep", durationSeconds: 1418 },
      ],
      details: async (url) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return {
          url,
          title: "Marfe takes it deep",
          durationSeconds: 1418,
          streamUrl: "https://sxyprn.com/stream.m3u8",
          uploadDate: "2026-03-05T10:00:00+00:00",
        };
      },
    }),
    dateWindowDays: 7,
    maxMatches: 1,
    detailConcurrency: 2,
  });
  const pending = lookup(SCENE);
  // Both posts must be in flight at once: serial detail fetches multiplied the
  // ladder's latency by the slice length for no reason.
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(peak, 2, "the slice is fetched concurrently");
  for (const resolve of release) resolve();
  const matches = await pending;
  assert.equal(matches.length, 2, "the bounded detail survivors are all returned to the ladder");
  assert.equal(matches[0]?.url, POST, "rank order decides the winner, not completion order");
});

test("the detail pass inside a scene resolve does not deadlock the shared fetch pool", async () => {
  // Same hazard as the pool rung's hydration, and it is reached more often: the
  // detail pass runs for every scene whose card pass matched, inside
  // `resolveLinks`' own fan-out. With the outer pool saturated, an inner acquire
  // on that same counter waits for a release only the inner pass can make.
  // `detailConcurrency: 3` against a saturated outer limit of 3 makes that
  // deterministic rather than a timing gamble.
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [
        { url: POST, title: "Marfe takes it deep", durationSeconds: 1418 },
        { url: OTHER, title: "Marfe takes it deep", durationSeconds: 1418 },
        { url: THIRD, title: "Marfe takes it deep", durationSeconds: 1418 },
      ],
      details: async (url) => ({
        url,
        title: "Marfe takes it deep",
        durationSeconds: 1418,
        streamUrl: "https://sxyprn.com/stream.m3u8",
        uploadDate: "2026-03-05T10:00:00+00:00",
      }),
    }),
    dateWindowDays: 7,
    maxMatches: 3,
    detailConcurrency: 3,
  });
  const scenes = ["s1", "s2", "s3"].map((id) => makeMatchScene({ ...SCENE, id: `test:${id}` }));
  const results = await withDeadline(
    mapWithConcurrency(scenes, (scene) => lookup(scene), 3),
    5_000,
    "the sxyprn detail pass deadlocked the shared fetch pool",
  );
  assert.equal(results.length, 3);
  for (const [index, matches] of results.entries()) {
    assert.equal(matches.length, 3, `scene ${index} verified every post rather than deadlocking`);
    assert.equal(matches[0]?.url, POST, "rank order still decides the winner");
  }
});
