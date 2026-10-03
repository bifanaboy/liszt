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
  await assert.rejects(client.videos.search("scene"), /circuit open/);
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
  await assert.rejects(client.videos.search("scene"), /circuit open/);
  assert.equal(searchCalls, 3, "and the re-opened break short-circuits again");
});

test("a refused call says the break is holding, and still names what opened it", async () => {
  // The production log repeated one live timeout for every scene a down source
  // was not being called for. A caller that is being refused has spent nothing,
  // and the log has to be able to tell that apart from a call that paid the
  // deadline - otherwise the cost bound is invisible exactly when it is working.
  const client = createSxyprnClient(
    packageStub({
      search: async () => {
        throw new Error("sxyprn search timed out after 15000ms");
      },
    }),
    { maxConsecutiveFailures: 1, cooldownMs: 60_000 },
  );
  await assert.rejects(client.videos.search("scene"), /timed out after 15000ms/);
  await assert.rejects(
    client.videos.search("scene"),
    /^Error: sxyprn circuit open \(\d+ of \d+ recent calls failed\); last: sxyprn search timed out after 15000ms$/,
  );
});

test("a source failing every other call still opens the break", async () => {
  // The shape production actually had: the ladder interleaves scenes, and each
  // scene searches several queries in turn, so a source that times out on every
  // second request never produces two failures IN A ROW. A counter that only
  // advances on a failure and resets on any success therefore never reached its
  // threshold, so the break stayed shut and every scene kept paying the full
  // deadline - which is what the run log showed: 110 rung errors in one run.
  let calls = 0;
  const client = createSxyprnClient(
    packageStub({
      search: async () => {
        calls += 1;
        if (calls % 2 === 1) throw new Error("sxyprn search timed out after 15000ms");
        return { videos: [] };
      },
    }),
    // Three in a row is never reached by this pattern, so only the failing
    // share can open the break.
    { maxConsecutiveFailures: 3, failureWindow: 4, failureRatio: 0.5, cooldownMs: 60_000 },
  );

  let held = false;
  for (let attempt = 0; attempt < 40 && !held; attempt += 1) {
    try {
      await client.videos.search(`scene-${attempt}`);
    } catch (error) {
      held = /circuit open/.test((error as Error).message);
    }
  }
  assert.ok(held, "the break opened while calls were still interleaved");
  assert.ok(
    calls <= 8,
    `the break opened after ${calls} calls, not after 40 deadlines of one per scene`,
  );
});

test("a source failing occasionally keeps being asked", async () => {
  // The other direction, and the reason the window is a SHARE rather than a
  // cumulative tally: a source that fails one call in six is healthy. A tally
  // would have opened the break on its fourth failure and never closed it,
  // because the only thing that cleared it was the half-open probe succeeding.
  let calls = 0;
  const client = createSxyprnClient(
    packageStub({
      search: async () => {
        calls += 1;
        if (calls % 6 === 0) throw new Error("403 from Cloudflare");
        return { videos: [] };
      },
    }),
    { maxConsecutiveFailures: 3, failureWindow: 4, failureRatio: 0.5, cooldownMs: 60_000 },
  );
  let refusals = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    // The client rethrows what the source threw; what matters is that the throw
    // is the source's own error and never the break's.
    await client.videos.search(`scene-${attempt}`).catch((error: Error) => {
      if (/circuit open/.test(error.message)) refusals += 1;
    });
  }
  assert.equal(refusals, 0, "a 1-in-6 failure rate never reaches the threshold");
  assert.equal(calls, 60, "so every call was actually made rather than short-circuited");
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

test("the detail pass reports which failure it hit, not only that it failed", async () => {
  // One opaque string per post failure made an upstream refusal, a network
  // failure, a parser break and the deadline a single bucket. The deadline is
  // the one kind the breaker can put a bound on, so it has to be separable from
  // the other three - otherwise the run log cannot say the cost is now bounded.
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [{ url: POST, title: "Marfe takes it deep", durationSeconds: 1418 }],
      details: async () => {
        throw new Error("sxyprn details timed out after 15000ms");
      },
    }),
    dateWindowDays: 7,
  });
  await assert.rejects(
    lookup(SCENE),
    /^Error: sxyprn post verification unavailable: sxyprn details timed out after 15000ms$/,
  );
});

test("a non-finite failing share is refused rather than silently disarming the window", () => {
  // A `NaN` share makes every `failures() >= minFailures` comparison false, so
  // the break falls back to consecutive failures alone and the interleaved
  // pattern the window was added for goes unbounded. Rejecting it loudly at
  // construction is the only answer that cannot be mistaken for a setting.
  assert.throws(() => createSxyprnClient(packageStub(), { failureRatio: Number.NaN }), RangeError);
  assert.throws(
    () => createSxyprnClient(packageStub(), { failureRatio: Number.POSITIVE_INFINITY }),
    RangeError,
  );
  // Finite shares are untouched: clamping would raise one above 1 into "open on
  // any failure".
  assert.doesNotThrow(() => createSxyprnClient(packageStub(), { failureRatio: 1 }));
});

test("a detail failure that is not an Error still names a reason", async () => {
  // The detail wrapper rethrows whatever it caught, so a truthy non-`Error` used
  // to reach the joined diagnostic as `undefined`, and a falsey one left a blank
  // field between two semicolons. Neither tells a reader anything about the run.
  const failures = new Map<string, unknown>([
    [POST, "502 from the edge"],
    [OTHER, { status: 403 }],
  ]);
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [POST, OTHER].map((url) => ({
        url,
        title: "Marfe takes it deep",
        durationSeconds: 1418,
      })),
      details: async (url) => {
        throw failures.get(url);
      },
    }),
    dateWindowDays: 7,
    maxMatches: 5,
  });
  const error = await lookup(SCENE).then(
    () => null,
    (thrown: Error) => thrown,
  );
  const message = error?.message ?? "";
  const reasons = message.slice("sxyprn post verification unavailable: ".length).split("; ");
  assert.ok(!/undefined/.test(message), `no reason is the string "undefined": ${message}`);
  assert.ok(
    reasons.every((reason) => reason.trim().length > 0),
    `every reason is readable: ${JSON.stringify(reasons)}`,
  );
});

test("the detail pass names at most three distinct reasons", async () => {
  // Enough to diagnose, not enough to read. A whole failed run's worth of
  // per-post strings is not a diagnosis, and the URLs must not leak into it.
  const lookup = createSxyprnLookup({
    client: stubClient({
      cards: [POST, OTHER, THIRD].map((url) => ({
        url,
        title: "Marfe takes it deep",
        durationSeconds: 1418,
      })),
      details: async (url) => {
        throw new Error(`failed on ${url}`);
      },
    }),
    dateWindowDays: 7,
    maxMatches: 5,
  });
  const error = await lookup(SCENE).then(
    () => null,
    (thrown: Error) => thrown,
  );
  const message = error?.message ?? "";
  assert.match(message, /^sxyprn post verification unavailable: /);
  const reasons = message.slice("sxyprn post verification unavailable: ".length).split("; ");
  assert.equal(reasons.length, 3, "three distinct reasons, capped");
});

test("a post refused by an open break is reported as the break, not a new failure", async () => {
  // The production line, end to end. The search is served from the rung's own
  // cache - the same studio slug really does recur across scenes - so this is a
  // detail pass that pays nothing and is still refused. The reported reason has
  // to say the break is holding, because that is what a run log reading it needs
  // to know: the rung is bounded, not down.
  const client = createSxyprnClient(
    packageStub({
      search: async () => ({
        videos: [{ url: POST, title: "Marfe takes it deep", durationSeconds: 1418 }],
      }),
      details: async () => {
        throw new Error("sxyprn details timed out after 15000ms");
      },
    }),
    { maxConsecutiveFailures: 1, cooldownMs: 60_000 },
  );
  const lookup = createSxyprnLookup({ client, dateWindowDays: 7 });
  await assert.rejects(lookup(SCENE), /post verification unavailable: sxyprn details timed out/);
  await assert.rejects(lookup(SCENE), /post verification unavailable: sxyprn circuit open/);
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
