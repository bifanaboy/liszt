/**
 * One sync cycle, end to end against a real (in-memory) SQLite store and fake
 * sources. This is where the three properties that no unit test can cover live:
 *
 *  - one failing source does not stop the others;
 *  - a source that returns nothing WITHOUT claiming it is empty fails the run
 *    and keeps its last-good rows (a parser bug must not delete a catalogue);
 *  - a repeat sync converges on the same rows instead of duplicating them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSync, dateOnly, normaliseScene, type SyncLookups } from "../src/pipeline/sync.ts";
import { createSingleFlight } from "../src/pipeline/scheduler.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { NullLogger } from "../src/core/logger.ts";
import { HttpFetcher } from "../src/core/fetcher.ts";
import { fixedClock } from "../src/sources/types.ts";
import type { Scene } from "../src/core/schema.ts";
import { createProgressTracker, type SyncProgress } from "../src/pipeline/progress.ts";
import type { PoolMatch } from "../src/tubes/eporner-pool.ts";
import type { RawScene, SourceAdapter, SourceResult } from "../src/sources/types.ts";

const NOW = "2026-03-10T00:00:00Z";
const FROM = dateOnly(new Date(new Date("2026-03-10T00:00:00Z").getTime() - 90 * 86_400_000));

function raw(id: string, over: Partial<RawScene> = {}): RawScene {
  return {
    sourceSceneId: id,
    title: `Scene ${id}`,
    releaseDate: "2026-03-01",
    performers: ["Marfe"],
    durationSec: 600,
    source: "test",
    provenance: { source: "test" },
    ...over,
  };
}

function adapter(
  id: string,
  fetch: () => Promise<SourceResult>,
  matcher: string | null = "sxyprn+eporner",
): SourceAdapter {
  return {
    id,
    name: id,
    authority: { name: "test", url: `https://example.test/${id}`, role: "catalogue source" },
    matcher,
    fetch,
  };
}

function buildSync(store: SqliteStore, sources: SourceAdapter[], windowDays = 90) {
  return createSync({
    store,
    sources,
    fetcher: new HttpFetcher(),
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays,
    fetchConcurrency: 2,
    lookups: { poolLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
  });
}

test("one failing source does not stop the others", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("good", async () => ({ scenes: [raw("1"), raw("2")], verifiedEmpty: false })),
    adapter("bad", async () => {
      throw new Error("upstream is down");
    }),
  ]);

  const summary = await sync("test");
  const bySource = new Map(summary.outcomes.map((entry) => [entry.source, entry]));
  assert.equal(bySource.get("good")?.ok, true);
  assert.equal(bySource.get("good")?.count, 2);
  assert.equal(bySource.get("bad")?.ok, false);
  assert.match(bySource.get("bad")?.error ?? "", /upstream is down/);
  assert.equal(summary.ok, false);
  assert.equal(summary.windowScenes, 2);

  // The failing source keeps an error status, and the healthy one is marked ok.
  const sources = new Map(store.listSources().map((entry) => [entry.sourceId, entry]));
  assert.match(sources.get("bad")?.lastError ?? "", /upstream is down/);
  assert.equal(sources.get("good")?.lastError, null);
  assert.ok(sources.get("good")?.lastSuccessAt);
  store.close();
});

test("source health stores the configured global window on success and failure", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(
    store,
    [
      adapter("madouqu", async () => ({ scenes: [raw("1")], verifiedEmpty: false }), null),
      adapter("broken", async () => {
        throw new Error("upstream is down");
      }),
    ],
    37,
  );

  await sync("test");
  const sources = new Map(store.listSources().map((entry) => [entry.sourceId, entry]));
  assert.equal(sources.get("madouqu")?.windowDays, 37);
  assert.equal(sources.get("broken")?.windowDays, 37);
  store.close();
});

test("an empty result that does not claim to be verified is a failure", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("suspicious", async () => ({ scenes: [], verifiedEmpty: false })),
  ]);
  const summary = await sync("test");
  assert.equal(summary.outcomes[0]?.ok, false);
  assert.match(summary.outcomes[0]?.error ?? "", /suspicious/);
  store.close();
});

test("a source that genuinely has nothing is a clean success", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("empty", async () => ({ scenes: [], verifiedEmpty: true })),
  ]);
  const summary = await sync("test");
  assert.equal(summary.outcomes[0]?.ok, true);
  assert.equal(summary.outcomes[0]?.count, 0);
  store.close();
});

test("a failed poll keeps the source's last-good in-window rows", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let healthy = true;
  const flaky = adapter("flaky", async () => {
    if (!healthy) throw new Error("temporarily hidden upstream");
    return { scenes: [raw("1"), raw("2")], verifiedEmpty: false };
  });
  const sync = buildSync(store, [flaky]);

  await sync("first");
  assert.equal(store.listWindow(FROM, "2026-03-10").length, 2);

  healthy = false;
  const second = await sync("second");
  assert.equal(second.outcomes[0]?.ok, false);
  // Retention: the records a temporarily-failing upstream omitted survive.
  assert.equal(store.listWindow(FROM, "2026-03-10").length, 2);
  store.close();
});

test("a repeat poll preserves resolved links, dead links and the re-verify watermark", async () => {
  // The bug this covers: `upsertScene` REPLACES `scene_links` from the scene it
  // is handed, and the scene a metadata poll builds knows nothing about
  // playback - so every poll erased every resolved link and every struck one.
  // The resolver's writes survived only for the scenes it happened to change in
  // the same cycle, which is not a property anyone could rely on.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false })),
  ]);

  await sync("first");
  const resolved: Scene = {
    ...(store.getScene("good:1") as Scene),
    videoUrls: [
      {
        source: "eporner",
        url: "https://www.eporner.com/video-live/",
        verifiedAt: "2026-03-05T00:00:00.000Z",
        verifyFailures: 0,
      },
    ],
    deadVideoUrls: [
      {
        source: "eporner",
        url: "https://www.eporner.com/video-dead/",
        deadAt: "2026-03-06T00:00:00.000Z",
        deadReason: "eporner video/id lookup found no record",
      },
    ],
    videoCheckedAt: "2026-03-05T00:00:00.000Z",
    videoMatching: {
      lane: "eporner-pool",
      matchedAt: "2026-03-05T00:00:00.000Z",
      rule: "duration+window",
      confidence: "high",
    },
  };
  store.upsertScene(resolved);

  // Two more polls. One would have been enough to show the loss; two also shows
  // the state is stable rather than decaying.
  await sync("second");
  await sync("third");

  const after = store.getScene("good:1") as Scene;
  assert.deepEqual(
    after.videoUrls.map((link) => link.url),
    ["https://www.eporner.com/video-live/"],
    "a resolved link survives a metadata poll",
  );
  assert.deepEqual(
    after.deadVideoUrls.map((link) => link.url),
    ["https://www.eporner.com/video-dead/"],
    "a struck link stays struck, and its history is not deleted either",
  );
  assert.equal(
    after.videoCheckedAt,
    "2026-03-05T00:00:00.000Z",
    "videoCheckedAt is carried forward, so re-verify still rotates over the genuinely stalest links",
  );
  assert.equal(after.videoMatching?.lane, "eporner-pool");
  store.close();
});

test("a repeat sync converges instead of duplicating", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("good", async () => ({ scenes: [raw("1"), raw("2")], verifiedEmpty: false })),
  ]);

  const first = await sync("first");
  const second = await sync("second");
  assert.equal(first.windowScenes, 2);
  assert.equal(second.windowScenes, 2);
  assert.equal(store.listWindow(FROM, "2026-03-10").length, 2);
  // A second run is recorded too: the ledger is append-only, not idempotent-by-hiding.
  assert.equal(store.recentRuns(10).length, 2);
  store.close();
});

test("scenes that left the rolling window are expired", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("aged", async () => ({
      scenes: [raw("old", { releaseDate: "2020-01-01" }), raw("new")],
      verifiedEmpty: false,
    })),
  ]);
  const summary = await sync("test");
  assert.equal(summary.expired, 1);
  assert.equal(summary.windowScenes, 1);
  assert.equal(store.getScene("aged:old"), null);
  store.close();
});

test("a record that fails the schema boundary is skipped, not fatal to the run", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    // `releaseDate` "not-a-date" cannot cross the boundary.
    adapter("mixed", async () => ({
      scenes: [raw("ok"), raw("broken", { releaseDate: "not-a-date" })],
      verifiedEmpty: false,
    })),
  ]);
  const summary = await sync("test");
  assert.equal(summary.outcomes[0]?.ok, true);
  assert.equal(summary.outcomes[0]?.count, 1);
  assert.equal(store.getScene("mixed:broken"), null);
  assert.ok(store.getScene("mixed:ok"));
  store.close();
});

test("the run ledger records each cycle with its outcomes", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [
    adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false })),
  ]);
  await sync("test");
  const [run] = store.recentRuns(1);
  assert.ok(run);
  assert.equal(run?.kind, "sync");
  assert.equal(run?.ok, true);
  assert.ok(run?.endedAt);
  assert.equal(run?.outcomes.length, 1);
  store.close();
});

/** A sync with the resolve stage switched on, for the ladder's end-to-end tests. */
function buildResolvingSync(
  store: SqliteStore,
  sources: SourceAdapter[],
  lookups: Partial<SyncLookups> = {},
) {
  return createSync({
    store,
    sources,
    fetcher: new HttpFetcher(),
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: {
      poolLookup: null,
      sxyprnLookup: null,
      ...lookups,
    },
  });
}

test("a pool match dated outside the window is refused end to end", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  // The scene's release date is 2026-03-01. A pool candidate uploaded three
  // weeks later is outside any sane window, so no URL may be written - the
  // rung reports the rejection and the scene stays unlinked for a later cycle.
  const sync = buildResolvingSync(
    store,
    [adapter("pooled", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    {
      poolLookup: async () => ({
        url: "",
        embedUrl: "",
        videoId: "",
        uploader: "Vovick17",
        title: "Marfe compilation",
        identityTier: 0,
        lagDays: 21,
        candidatesConsidered: 40,
        durationPassed: 1,
        hydrated: 1,
        rejectedByDate: 1,
        unknownDate: 0,
        hydrationCapped: false,
        omittedCandidates: 0,
        fallbackCandidates: [],
        rejected: "date",
      }),
    },
  );
  const summary = await sync("test");
  assert.equal(summary.matched, 0, "nothing was linked");
  assert.equal(summary.rejections.date, 1, "the rejection is visible, not silent");
  const scene = store.getScene("pooled:1");
  assert.ok(scene);
  assert.equal(scene.videoUrls.length, 0, "a missing link beats a wrong one");
  // Retried next cycle, never written off.
  assert.equal(scene.deadVideoUrls.length, 0);
  assert.ok(scene.videoCheckedAt, "but it is stamped as checked");
  store.close();
});

test("an in-window pool match IS linked, and the winner's tier drives confidence", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildResolvingSync(
    store,
    [adapter("pooled", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    {
      poolLookup: async () => ({
        url: "https://www.eporner.com/video-abc/",
        embedUrl: "https://www.eporner.com/embed/abc/",
        videoId: "abc",
        uploader: "Vovick17",
        title: "Marfe compilation",
        identityTier: 1,
        lagDays: 2,
        candidatesConsidered: 40,
        durationPassed: 1,
        hydrated: 1,
        rejectedByDate: 0,
        unknownDate: 0,
        hydrationCapped: false,
        omittedCandidates: 0,
        fallbackCandidates: [],
        rejected: null,
      }),
    },
  );
  const summary = await sync("test");
  assert.equal(summary.matched, 1);
  assert.deepEqual(summary.tiers, [1], "the tier histogram sees the real tier");
  const scene = store.getScene("pooled:1");
  assert.ok(scene, "the scene is still stored, just unlinked");
  assert.equal(scene.videoUrls[0]?.url, "https://www.eporner.com/video-abc/");
  assert.equal(scene.videoMatching?.confidence, "high");
  assert.equal(scene.videoMatching?.lane, "eporner-pool");
  store.close();
});

test("a tier-0 winner is recorded as LOW CONFIDENCE for eyeballing", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildResolvingSync(
    store,
    [adapter("pooled", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    {
      poolLookup: async () => ({
        url: "https://www.eporner.com/video-abc/",
        embedUrl: "https://www.eporner.com/embed/abc/",
        videoId: "abc",
        uploader: "Vovick17",
        title: "unrelated clip",
        identityTier: 0,
        lagDays: 2,
        candidatesConsidered: 40,
        durationPassed: 3,
        hydrated: 3,
        rejectedByDate: 0,
        unknownDate: 0,
        hydrationCapped: false,
        omittedCandidates: 0,
        fallbackCandidates: [],
        rejected: null,
      }),
    },
  );
  await sync("test");
  const scene = store.getScene("pooled:1");
  assert.ok(scene);
  assert.equal(scene.videoMatching?.confidence, "low");
  assert.equal(scene.videoUrls.length, 1, "it is still linked - flagged, not withheld");
  store.close();
});

test("deferred lanes still produce ZERO links after the gate rewrite", async () => {
  // A scope regression guard, not a target. madouqu and fc2cmadb keep
  // `matcher: null`, and the gate rewrite must not have made either start
  // linking - especially not by inferring eligibility from the data.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const { createFc2CmadbStudio } = await import("../src/sources/fc2cmadb.ts");
  let consulted = 0;
  const count = async (): Promise<PoolMatch> => {
    consulted += 1;
    return {
      url: "https://www.eporner.com/video-abc/",
      embedUrl: "https://www.eporner.com/embed/abc/",
      videoId: "abc",
      uploader: "Vovick17",
      title: "anything",
      identityTier: 3,
      lagDays: 0,
      candidatesConsidered: 1,
      durationPassed: 1,
      hydrated: 1,
      rejectedByDate: 0,
      unknownDate: 0,
      hydrationCapped: false,
      omittedCandidates: 0,
      fallbackCandidates: [],
      rejected: null,
    };
  };
  const sync = buildResolvingSync(
    store,
    [
      createFc2CmadbStudio(),
      adapter("madouqu", async () => ({ scenes: [raw("1")], verifiedEmpty: false }), null),
    ],
    { poolLookup: count },
  );
  const summary = await sync("test");
  assert.equal(summary.matched, 0, "neither deferred lane linked");
  assert.equal(summary.rejections.attempted, 0, "the ladder was never entered for them");
  assert.equal(consulted, 0, "no rung was even asked");
  for (const id of ["fc2cmadb", "madouqu"]) {
    const scene = store.getScene(`${id}:1`);
    assert.equal(scene?.videoUrls.length ?? 0, 0, `${id} stayed unlinked`);
  }
  store.close();
});

test("the fc2cmadb stub fails its lane cleanly without disturbing the others", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const { createFc2CmadbStudio } = await import("../src/sources/fc2cmadb.ts");
  const sync = buildSync(store, [
    createFc2CmadbStudio(),
    adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false })),
  ]);
  const summary = await sync("test");
  const outcomes = new Map(summary.outcomes.map((entry) => [entry.source, entry]));
  assert.equal(outcomes.get("good")?.ok, true);
  assert.equal(summary.windowScenes, 1);
  // The stub never reports a verified-empty result, so it cannot trip the
  // suspicious-empty protection and delete a lane.
  assert.equal(outcomes.get("fc2cmadb")?.ok, false);
  store.close();
});

test("normaliseScene builds the <source>:<scene> identity and keeps provenance", () => {
  const now = new Date(NOW);
  const scene = normaliseScene(
    adapter("lancelot-styles-evolution", async () => ({ scenes: [], verifiedEmpty: true })),
    raw("4683299", { studioCode: "LS-1" }),
    now,
  );
  assert.equal(scene.id, "lancelot-styles-evolution:4683299");
  assert.equal(scene.labelId, "lancelot-styles-evolution");
  assert.equal(scene.provenance.length, 1);
  assert.equal(scene.provenance[0]?.fetchedAt, now.toISOString());
  assert.equal(scene.studioCode, "LS-1");
});

test("a sub-label becomes its own label identity", () => {
  // The sub-label is part of the KEY, not just of the label fields. madouqu
  // cross-lists the same post into several categories, so with a bare
  // `<source>:<scene>` key those records collided on one row and every category
  // but the last one walked was silently lost.
  const madouqu = adapter("madouqu", async () => ({ scenes: [], verifiedEmpty: true }), null);
  const peach = normaliseScene(
    madouqu,
    raw("123", { studioId: "madouqu-peach", studio: "Peach" }),
    new Date(NOW),
  );
  const jelly = normaliseScene(
    madouqu,
    raw("123", { studioId: "madouqu-jelly-91", studio: "Jelly/91" }),
    new Date(NOW),
  );
  assert.equal(peach.id, "madouqu:madouqu-peach:123");
  assert.equal(peach.labelId, "madouqu-peach");
  assert.equal(peach.label, "Peach");
  assert.notEqual(peach.id, jelly.id, "the same post under two sub-labels is two records");
});

test("a single-label source keeps the two-part key", () => {
  // Widening the key must not churn every existing row of every lane that
  // never emits a sub-label.
  const scene = normaliseScene(
    adapter("lancelot-styles-evolution", async () => ({ scenes: [], verifiedEmpty: true })),
    raw("4683299", { studioCode: "LS-1" }),
    new Date(NOW),
  );
  assert.equal(scene.id, "lancelot-styles-evolution:4683299");
  assert.equal(scene.labelId, "lancelot-styles-evolution");
});

test("single-flight collapses concurrent cycles into one run", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let runs = 0;
  const flight = createSingleFlight(async () => {
    runs += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return runs;
  });
  const [a, b, c] = await Promise.all([flight(), flight(), flight()]);
  assert.equal(runs, 1);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(c, 1);
  // After settling, a new call starts a fresh cycle.
  assert.equal(await flight(), 2);
  store.close();
});

/* ---- Live progress --------------------------------------------------------
   The dashboard's meters are driven entirely by the tracker, so what matters is
   that the pipeline narrates itself COMPLETELY and WHILE it runs: every source
   accounted for (including the ones that threw), every resolve step counted
   against the queue it actually built, and the run finished. A bar that sits
   short of its total is indistinguishable from a hang. */

function progressSync(store: SqliteStore, over: Partial<Parameters<typeof createSync>[0]>) {
  return createSync({
    store,
    sources: [],
    fetcher: new HttpFetcher(),
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { poolLookup: null, sxyprnLookup: null },
    resolveEnabled: false,
    ...over,
  });
}

test("progress is live mid-run, and a source that throws still counts as an attempt", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const progress = createProgressTracker();
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Concurrency 1 makes the order deterministic: the first source completes,
  // then the second starts and hangs, which is the moment worth inspecting.
  let midRun: SyncProgress | null = null;
  const sync = progressSync(store, {
    sources: [
      adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false })),
      adapter("bad", async () => {
        midRun = progress.snapshot();
        await gate;
        throw new Error("upstream is down");
      }),
    ],
    fetchConcurrency: 1,
    progress,
  });

  const started = sync("test");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(midRun, "the run reached the second source");
  const live = midRun as SyncProgress;
  assert.equal(live.active, true, "a reader can see the cycle while it is still working");
  assert.equal(live.stage, "populating");
  assert.equal(live.populate.done, 1, "the first source is already counted");
  assert.equal(live.populate.total, 2);
  assert.deepEqual(live.populate.current, ["bad"], "the source in flight is named");

  release();
  const summary = await started;
  assert.equal(summary.ok, false, "the throwing source still failed the run");
  const after = progress.snapshot();
  assert.equal(after.populate.done, 2, "a failed source is an ATTEMPT, so the bar still fills");
  assert.deepEqual(after.populate.current, []);
  assert.equal(after.active, false, "the bar collapsed when the run ended");
  assert.equal(after.stage, "idle");
  store.close();
});

test("a cycle with the links stage switched off still finishes cleanly", async () => {
  // `--no-links` runs never enter the resolve stage, so the Linking meter has no
  // countable total - and the run must still end, or that bar hangs forever.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const progress = createProgressTracker();
  const sync = progressSync(store, {
    sources: [adapter("only", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))],
    progress,
  });
  await sync("test");
  const snapshot = progress.snapshot();
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.populate.done, 1);
  assert.equal(snapshot.link.total, 0, "nothing was queued, so nothing can be counted");
  assert.equal(snapshot.link.done, 0);
  assert.equal(snapshot.link.verifyTotal, 0);
  store.close();
});

test("a cycle with no sources at all still finishes", async () => {
  // Zero sources is the degenerate case the meters have to survive: no
  // denominator anywhere, and a row that must still collapse when the run ends.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const progress = createProgressTracker();
  const summary = await progressSync(store, { progress })("test");
  const snapshot = progress.snapshot();
  assert.equal(summary.outcomes.length, 0);
  assert.equal(snapshot.populate.total, 0);
  assert.equal(snapshot.populate.done, 0);
  assert.equal(snapshot.active, false);
  store.close();
});

test("the resolve stage counts the queue it built, not the whole window", async () => {
  // Four scenes land in the window; `lookups.limit` cuts the queue to two. A
  // denominator taken from the window would render a bar stuck at 50%.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const progress = createProgressTracker();
  const denominators = new Set<number>();
  const tap = createProgressTracker();
  tap.begin("tap", NOW, { sources: 1, uploaders: 0 });
  const sync = progressSync(store, {
    sources: [
      adapter("many", async () => ({
        scenes: [raw("1"), raw("2"), raw("3"), raw("4")],
        verifiedEmpty: false,
      })),
    ],
    resolveEnabled: true,
    lookups: { poolLookup: null, sxyprnLookup: null, limit: 2 },
    progress: {
      ...tap,
      linkStep: (done, total, matched) => {
        denominators.add(total);
        tap.linkStep(done, total, matched);
      },
    },
  });
  await sync("test");
  assert.deepEqual([...denominators], [2], "one denominator, and it is the capped queue");
  const snapshot = tap.snapshot();
  assert.equal(snapshot.link.total, 2);
  assert.equal(snapshot.link.done, 2, "the bar reaches 100% at the cap");
  assert.equal(snapshot.link.substage, "verify", "the cycle moved on to re-verify");
  assert.equal(snapshot.active, false);
  assert.equal(progress.snapshot().active, false, "an untouched tracker is still valid");
  store.close();
});

for (const failure of ["ledger", "log"] as const) {
  test(`a failure in the opening ${failure} ends progress and propagates the original error`, async (t) => {
    const store = new SqliteStore(":memory:");
    t.after(() => store.close());
    store.migrate();
    const progress = createProgressTracker();
    const error = new Error(`opening ${failure} failed`);
    const log = new NullLogger();
    if (failure === "ledger")
      t.mock.method(store, "recordRun", () => {
        throw error;
      });
    else
      t.mock.method(log, "info", () => {
        throw error;
      });
    const sync = progressSync(store, { progress, log });
    await assert.rejects(sync("test"), (actual) => actual === error);
    assert.equal(progress.snapshot().active, false);
    assert.equal(progress.snapshot().stage, "error");
    assert.equal(progress.snapshot().populate.done, 0);
  });
}
