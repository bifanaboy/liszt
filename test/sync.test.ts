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
    windowDays: 90,
    authority: { name: "test", url: `https://example.test/${id}`, role: "catalogue source" },
    matcher,
    fetch,
  };
}

function buildSync(store: SqliteStore, sources: SourceAdapter[]) {
  return createSync({
    store,
    sources,
    fetcher: new HttpFetcher(),
    clock: fixedClock(NOW),
    log: new NullLogger(),
    windowDays: 90,
    fetchConcurrency: 2,
    lookups: { poolLookup: null, sxyprnLookup: null, openLookup: null },
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

test("a repeat sync converges instead of duplicating", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const sync = buildSync(store, [adapter("good", async () => ({ scenes: [raw("1"), raw("2")], verifiedEmpty: false }))]);

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
  const sync = buildSync(store, [adapter("good", async () => ({ scenes: [raw("1")], verifiedEmpty: false }))]);
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
      openLookup: null,
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
      poolLookup: async () =>
        ({
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
      poolLookup: async () =>
        ({
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
      poolLookup: async () =>
        ({
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
  const scene = normaliseScene(
    adapter("madouqu", async () => ({ scenes: [], verifiedEmpty: true }), null),
    raw("123", { studioId: "madouqu-peach", studio: "Peach" }),
    new Date(NOW),
  );
  assert.equal(scene.id, "madouqu:123");
  assert.equal(scene.labelId, "madouqu-peach");
  assert.equal(scene.label, "Peach");
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
