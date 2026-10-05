/**
 * The trusted-pool index, against a captured profile card fixture. Offline: the
 * HTML is pinned, so the assertions are about the parser, not the network.
 *
 * The fixture records what the live listing actually exposes: a title (in `alt`
 * and in `.mbtit`) and a duration (`MM:SS`), and NO upload date. That finding is
 * why the pre-filter is the duration half only, and why the date enters the
 * index only at hydration.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCardDate,
  parseClockDuration,
  parseProfileListing,
  profileListingUrl,
  preFilter,
  fullRewalkDue,
  indexPool,
  createPoolLookup,
  gatherPoolSurvivors,
  POOL_FULL_REWALK_KEY,
} from "../src/tubes/eporner-pool.ts";
import { mapWithConcurrency } from "../src/core/concurrency.ts";
import { makeMatchScene, withDeadline } from "./helpers.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { FetchError } from "../src/core/fetcher.ts";
import type { Fetcher } from "../src/sources/types.ts";

/** A fetcher serving canned pages per page number; 404s end a walk. */
function textFetcher(pages: Record<number, string>): Fetcher {
  return {
    fetch: async (url: string) => {
      const page = Number(/uploaded-videos\/(\d+)\/?$/.exec(url)?.[1] ?? 1);
      const body = pages[page];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    },
    text: async (url: string) => {
      const page = Number(/uploaded-videos\/(\d+)\/?$/.exec(url)?.[1] ?? 1);
      const body = pages[page];
      if (body === undefined) {
        // A 404 is how a newest-first walk legitimately ends.
        throw new FetchError(`GET ${url} -> 404`, "definitive", 404);
      }
      return body;
    },
    json: async <T>() => ({}) as T,
  };
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "eporner-profile.html");
const NOW = new Date("2026-03-10T00:00:00Z");

test("pagination is path-based: the query form 301s back to page 1", () => {
  // Verified live: `/uploaded-videos/?page=2` answers 301; `/uploaded-videos/2/`
  // answers 200 with different videos.
  assert.equal(
    profileListingUrl("Vovick17", 1),
    "https://www.eporner.com/profile/Vovick17/uploaded-videos/",
  );
  assert.equal(
    profileListingUrl("Vovick17", 2),
    "https://www.eporner.com/profile/Vovick17/uploaded-videos/2/",
  );
  assert.ok(!profileListingUrl("Vovick17", 2).includes("?"));
});

test("a card yields its id, title, and duration from the listing", () => {
  const entries = parseProfileListing(readFileSync(FIXTURE, "utf8"), NOW);
  assert.equal(entries.length, 3);
  const first = entries[0]!;
  assert.equal(first.id, "Gnn5wNDvbnB");
  assert.equal(first.title, "This Big Ass Is Suspicious - Diabella Eclair");
  assert.equal(first.durationSec, 2138);
  // The hd-porn URL shape yields its id too.
  assert.equal(entries[1]!.id, "ILJdWOuZiwN");
  assert.equal(entries[1]!.durationSec, 5025);
});

test("a card with no usable title or duration is kept, not invented", () => {
  const plain = parseProfileListing(readFileSync(FIXTURE, "utf8"), NOW)[2]!;
  assert.equal(plain.id, "ZzQqQqQqQ1");
  // "Watch" is a placeholder label, not a title.
  assert.equal(plain.title, null);
  assert.equal(plain.durationSec, null);
});

test("the listing carries no upload date, so added stays null", () => {
  for (const entry of parseProfileListing(readFileSync(FIXTURE, "utf8"), NOW)) {
    assert.equal(entry.added, null);
  }
});

test("a page with no video links is a shape change and throws", () => {
  assert.throws(() => parseProfileListing("<html><body>nope</body></html>", NOW), /shape change/);
});

test("clock durations parse, and nonsense does not", () => {
  assert.equal(parseClockDuration("35:38"), 2138);
  assert.equal(parseClockDuration("1:23:45"), 5025);
  assert.equal(parseClockDuration("0:00"), null);
  assert.equal(parseClockDuration("112"), null);
  assert.equal(parseClockDuration(null), null);
});

test("a card date that is not a real calendar date is dropped, not invented", () => {
  // The mojibake'd pool titles contain digit runs that look exactly like dates.
  // A live card read `2026-19-07` - month 19. Emitting it would hand the index a
  // confident wrong timestamp, and `poolWatermark` is `MAX(added)`, so one such
  // row freezes the incremental walk at one page.
  assert.equal(parseCardDate("published 2026-19-07", NOW), null);
  assert.equal(parseCardDate("published 2026-13-01", NOW), null);
  assert.equal(parseCardDate("19.13.2026", NOW), null, "dotted form, month 13");
  assert.equal(parseCardDate("32.01.2026", NOW), null, "dotted form, day 32");
  // Real dates, in all three accepted shapes, still parse. The dotted form is
  // D.M.Y, so this is 19 February - not the 19th of an impossible month.
  assert.equal(parseCardDate("published 2026-03-05", NOW), "2026-03-05");
  assert.equal(parseCardDate("05.03.2026", NOW), "2026-03-05");
  assert.equal(parseCardDate("19.02.2026", NOW), "2026-02-19");
  assert.equal(parseCardDate("Mar 5, 2026", NOW), "2026-03-05");
  assert.equal(parseCardDate("3 hours ago", NOW), "2026-03-09T21:00:00.000Z");
  assert.equal(parseCardDate("no date here", NOW), null);
  // Today itself is allowed: a card uploaded an instant ago is not in the future.
  assert.equal(parseCardDate("published 2026-03-10", NOW), "2026-03-10");
});

test("a card date in the future is dropped, because a video cannot be", () => {
  // Measured: the mojibake yields real-looking FORWARD dates too. `poolWatermark`
  // is `MAX(added)`, so one such row puts the watermark ahead of every real
  // upload and the incremental walk then stops on its first page forever,
  // silently freezing the index and starving the pool rung.
  assert.equal(parseCardDate("published 2026-11-07", NOW), null);
  assert.equal(parseCardDate("2027-07-07", NOW), null);
  assert.equal(parseCardDate("Nov 7 2026", NOW), null);
  assert.equal(parseCardDate("07.11.2026", NOW), null);
  // One day past is already impossible.
  assert.equal(parseCardDate("published 2026-03-11", NOW), null);
});

test("the pre-filter is the DURATION half only, and nothing else", () => {
  const scene = makeMatchScene({
    id: "test:1",
    title: "Marfe takes it deep",
    performers: ["Marfe okkk"],
    releaseDate: "2026-03-04",
    durationSec: 2138,
  });
  const good = {
    id: "a",
    uploader: "Vovick17",
    title: "Marfe compilation 0304",
    added: null,
    durationSec: 2138,
    hydratedAt: null,
    views: null,
  };
  // Right duration: survives, whatever the title and whatever the date.
  assert.equal(preFilter(scene, good, { durationToleranceSec: 2 }), true);
  // Right duration, no identity at all: STILL survives. The pre-filter no
  // longer pre-judges identity - it ranks later, in `pickMatch`.
  assert.equal(
    preFilter(scene, { ...good, title: "unrelated clip" }, { durationToleranceSec: 2 }),
    true,
  );
  // Right identity, wrong duration: rejected without any network call.
  assert.equal(
    preFilter(scene, { ...good, durationSec: 2500 }, { durationToleranceSec: 2 }),
    false,
  );
  // Boundary: exactly at the tolerance is inside, one second past is not.
  assert.equal(preFilter(scene, { ...good, durationSec: 2140 }, { durationToleranceSec: 2 }), true);
  assert.equal(
    preFilter(scene, { ...good, durationSec: 2141 }, { durationToleranceSec: 2 }),
    false,
  );
  // Unknown duration: passes through so hydration can supply the real one.
  assert.equal(preFilter(scene, { ...good, durationSec: null }, { durationToleranceSec: 2 }), true);
  // No title at all: nothing to rank on, and hydration will not invent one.
  assert.equal(preFilter(scene, { ...good, title: null }, {}), false);
});

test("setPoolHydration round-trips the date the API supplied, as ISO UTC", () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    store.upsertPoolVideo({
      id: "abc",
      uploader: "Vovick17",
      title: "Marfe compilation",
      added: null,
      // The listing supplies a duration, which is why this row is already
      // "hydrated" as far as duration goes but has no date at all.
      durationSec: 2138,
      hydratedAt: "2026-03-04T00:00:00.000Z",
      views: null,
    });
    assert.equal(store.poolUndatedCount(), 1);

    store.setPoolHydration(
      "abc",
      "Vovick17",
      2138,
      "2026-03-05 11:22:33",
      "2026-03-10T00:00:00.000Z",
    );
    const [row] = store.poolVideosForUploader("Vovick17");
    assert.equal(
      row!.added,
      "2026-03-05T11:22:33.000Z",
      "normalised so the TEXT range scan sorts correctly",
    );
    assert.equal(row!.durationSec, 2138);
    assert.equal(store.poolUndatedCount(), 0);

    // A re-hydration that supplies no date must not ERASE the one already
    // stored: `added = COALESCE(?, added)`, and dropping it would make the
    // video permanently inadmissible and silently unrecoverable.
    store.setPoolHydration("abc", "Vovick17", 2138, null, "2026-03-11T00:00:00.000Z");
    assert.equal(store.poolVideosForUploader("Vovick17")[0]!.added, "2026-03-05T11:22:33.000Z");
  } finally {
    store.close();
  }
});

test("a dated row is now findable by the window query", () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    store.upsertPoolVideo({
      id: "abc",
      uploader: "Vovick17",
      title: "t",
      added: "2026-03-05T11:22:33.000Z",
      durationSec: 2138,
      hydratedAt: null,
      views: null,
    });
    // The naive zoneless format does not sort against an ISO bound; this is the
    // regression that `toIsoUtc` at the write boundary prevents.
    const inWindow = store.poolVideosInWindow(
      "Vovick17",
      "2026-03-04T00:00:00.000Z",
      "2026-03-12T00:00:00.000Z",
    );
    assert.equal(inWindow.length, 1);
  } finally {
    store.close();
  }
});

test("the window query's duration band keeps a row with no duration", () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const window = ["2026-03-04T00:00:00.000Z", "2026-03-12T00:00:00.000Z"] as const;
  try {
    for (const [id, durationSec] of [
      ["inside", 2139],
      ["outside", 2140],
      ["unknown", null],
    ] as const) {
      store.upsertPoolVideo({
        id,
        uploader: "Vovick17",
        title: "t",
        added: "2026-03-05T11:22:33.000Z",
        durationSec,
        hydratedAt: null,
        views: null,
      });
    }
    assert.equal(
      store.poolVideosInWindow("Vovick17", ...window).length,
      3,
      "unbanded is unchanged",
    );
    assert.deepEqual(
      store
        .poolVideosInWindow("Vovick17", ...window, { durationSec: 2138, toleranceSec: 1 })
        .map((row) => row.id),
      ["inside", "unknown"],
      "the gate's own arithmetic, in SQL; a row with no duration is still examined",
    );
  } finally {
    store.close();
  }
});

test("a full re-walk is due on the first run and then only after the cadence", () => {
  assert.equal(fullRewalkDue(null, NOW, 7), true);
  assert.equal(fullRewalkDue("2026-03-09T00:00:00Z", NOW, 7), false);
  assert.equal(fullRewalkDue("2026-03-01T00:00:00Z", NOW, 7), true);
});

test("the undated working set is ordered newest-first and capped in SQL", () => {
  // `maxConsidered` in the rung silently assumed newest-first order, which was
  // never asserted in SQL - so the cap cut an arbitrary subset of the account
  // rather than its oldest videos. The walk inserts newest-first, so `rowid`
  // order is newest-first, and saying so explicitly is the whole fix.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    for (const id of ["newest", "middle", "oldest"]) {
      store.upsertPoolVideo({
        id,
        uploader: "Vovick17",
        title: id,
        added: null,
        durationSec: 600,
        hydratedAt: "2026-03-10T00:00:00.000Z",
        views: null,
      });
    }
    const all = store.poolVideosUndated("Vovick17");
    assert.deepEqual(
      all.map((row) => row.id),
      ["newest", "middle", "oldest"],
    );
    assert.deepEqual(
      store.poolVideosUndated("Vovick17", 2).map((row) => row.id),
      ["newest", "middle"],
      "the cap keeps the newest, not an arbitrary subset",
    );
    assert.deepEqual(store.poolVideosUndated("Vovick17", 0), []);
    // A dated row is not in this set at all.
    store.setPoolHydration(
      "middle",
      "Vovick17",
      600,
      "2026-03-05 00:00:00",
      "2026-03-10T00:00:00.000Z",
    );
    assert.deepEqual(
      store.poolVideosUndated("Vovick17").map((row) => row.id),
      ["newest", "oldest"],
    );
  } finally {
    store.close();
  }
});

test("the undated SQL cap rotates, so the rows it cut become reachable", () => {
  // The undated working set is capped in SQL by `maxConsidered`, and ordering it
  // by `rowid` alone made that cap a FIXED window: the same newest rows for every
  // scene of every run. The fair rotation in the rung rotated *within* the cut
  // and never past it, so an account holding more undated rows than the cap had
  // identity-bearing candidates the bounded search could never examine, however
  // many cycles ran.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    for (let index = 0; index < 4; index += 1) {
      store.upsertPoolVideo({
        id: `row${index}`,
        uploader: "Vovick17",
        title: `row${index}`,
        added: null,
        durationSec: 600,
        hydratedAt: NOW.toISOString(),
        views: null,
      });
    }
    assert.deepEqual(
      store.poolVideosUndated("Vovick17", 2).map((row) => row.id),
      ["row0", "row1"],
      "the first pass examines the newest rows, as before",
    );

    // A pass over the cut marks its rows, so they rotate behind the unattempted
    // tail rather than being re-cut on every run.
    store.markPoolHydrationAttempt("row0", "Vovick17", NOW.toISOString());
    store.markPoolHydrationAttempt("row1", "Vovick17", new Date(NOW.getTime() + 1).toISOString());
    assert.deepEqual(
      store.poolVideosUndated("Vovick17", 2).map((row) => row.id),
      ["row2", "row3"],
      "the next pass examines rows the previous cap never reached",
    );

    // With everything attempted, the order is least-recently-attempted first, so
    // the cut keeps moving instead of parking on one slice of the account.
    store.markPoolHydrationAttempt("row2", "Vovick17", new Date(NOW.getTime() + 2).toISOString());
    store.markPoolHydrationAttempt("row3", "Vovick17", new Date(NOW.getTime() + 3).toISOString());
    assert.deepEqual(
      store.poolVideosUndated("Vovick17").map((row) => row.id),
      ["row0", "row1", "row2", "row3"],
      "the longest-idle rows lead, so the cut cycles through the whole account",
    );
  } finally {
    store.close();
  }
});

test("a truncated re-walk never prunes by absence", async () => {
  // Prune-by-absence reads "not seen" as "deleted upstream". On a walk that
  // stopped early - past the window, past the watermark, a short page, or the
  // maxPages ceiling - "not seen" means "we stopped looking", and deleting on
  // that basis removes the whole un-walked tail of the account in one pass.
  const store = new SqliteStore(":memory:");
  store.migrate();
  /** A card whose only date is the given one, or none at all. */
  const card = (id: string, date?: string): string =>
    `<div class="mb"><a href="/video-${id}/slug/"><img alt="Scene ${id}" /></a>` +
    `<p class="mbstats">${date ?? ""}<span class="mbtim" title="Duration">10:00</span></p></div>`;
  const page = (ids: string[], date?: string): string => ids.map((id) => card(id, date)).join("\n");
  const index = (pages: Record<number, string>) =>
    indexPool({
      store,
      fetcher: textFetcher(pages),
      now: NOW,
      uploaders: ["Vovick17"],
      windowDays: 90,
      fullRewalkDays: 7,
      log: () => {},
    });

  try {
    // Last complete walk left five rows behind.
    for (const id of ["a", "b", "c", "d", "e"]) {
      store.upsertPoolVideo({
        id,
        uploader: "Vovick17",
        title: id,
        added: null,
        durationSec: 600,
        hydratedAt: "2026-03-10T00:00:00.000Z",
        views: null,
      });
    }

    // COMPLETE walk: page 1 is full (a short page is itself a stop), and page 2
    // answers 404, so the end of the listing was genuinely reached. `d` and `e`
    // were deleted upstream, and saying so is the whole point of the re-walk.
    const complete = await index({
      1: page(["a", "b", "c", "f", "g", "h", "i", "j", "k", "l", "m", "n"]),
    });
    assert.equal(complete.ok, true);
    assert.equal(complete.uploaders[0]!.endOfListing, true);
    assert.equal(complete.uploaders[0]!.pruned, 2, "d and e were genuinely deleted upstream");
    assert.equal(store.poolVideoCount(), 12);

    // TRUNCATED walk: every card is dated far in the past, so the window stop
    // fires on page 1 and the rest of the account is never looked at.
    for (const id of ["o", "p", "q"]) {
      store.upsertPoolVideo({
        id,
        uploader: "Vovick17",
        title: id,
        added: null,
        durationSec: 600,
        hydratedAt: "2026-03-10T00:00:00.000Z",
        views: null,
      });
    }
    const truncated = await index({
      1: page(["a", "b", "c", "f", "g", "h", "i", "j", "k", "l", "m", "n"], "Mar 1, 2019"),
      2: page(["o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"], "Mar 1, 2019"),
    });
    assert.equal(truncated.ok, true);
    assert.equal(
      truncated.uploaders[0]!.endOfListing,
      false,
      "the walk stopped early, not at the end",
    );
    assert.equal(truncated.uploaders[0]!.pagesFetched, 1);
    assert.equal(truncated.uploaders[0]!.pruned, 0, "nothing may be deleted on a truncated walk");
    assert.equal(
      store.poolVideoCount(),
      15,
      "o, p and q survive: they were never looked at, not deleted upstream",
    );
  } finally {
    store.close();
  }
});

test("a card's date is read from its own card, not its neighbour's", () => {
  // The meta line was read from a fixed 1200-byte window past the anchor, so a
  // date in the NEXT card could be indexed against THIS one - a confidently
  // wrong date, which then fails (or passes) the window for the wrong reason.
  const html =
    `<div class="video_container"><div class="mb"><a href="/video-AAAA1111/first/"><img alt="First" /></a>` +
    `<p class="mbstats"><span class="mbtim" title="Duration">10:00</span></p></div></div>` +
    `<div class="video_container"><div class="mb"><a href="/video-BBBB2222/second/"><img alt="Second" /></a>` +
    `<p class="mbstats">Jan 2, 2021<span class="mbtim" title="Duration">20:00</span></p></div></div>`;
  const entries = parseProfileListing(html, NOW);
  assert.equal(entries.length, 2);
  assert.equal(entries[0]!.id, "AAAA1111");
  assert.equal(entries[0]!.added, null, "the first card has no date of its own to read");
  assert.equal(entries[0]!.durationSec, 600);
  assert.equal(entries[1]!.id, "BBBB2222");
  assert.equal(entries[1]!.added, "2021-01-02", "the second card reads its own date");
  assert.equal(entries[1]!.durationSec, 1200);
});

test("a nested shared-pool fan-out deadlocks, which is the hazard `mapIsolated` removes", async () => {
  // Demonstrated, not asserted from theory: a task holding the only slot of the
  // shared pool asks that same pool for a second one. The inner `acquire` waits
  // for a release, and the only thing that can release is work the inner
  // acquire is itself blocking - so it never settles. If this ever stops
  // deadlocking the pool grew a re-entrancy guard and the isolation below is
  // belt-and-braces; if it starts passing silently, the guard below is vacuous.
  await assert.rejects(
    withDeadline(
      mapWithConcurrency([0], () => mapWithConcurrency([1, 2], async (n) => n, 1), 1),
      250,
      "a re-entrant shared-pool fan-out",
    ),
    /a re-entrant shared-pool fan-out/,
  );
});

test("hydration inside a scene resolve does not deadlock the shared fetch pool", async () => {
  // `gatherPoolSurvivors` runs INSIDE `resolveLinks`' own fan-out, so by the
  // time it hydrates the caller already holds a slot of the shared pool. If
  // hydration drew from that same non-re-entrant pool, every inner acquire would
  // wait for a release only the hydration could make. The outer fan-out below
  // runs at the default limit of 4 over exactly 4 scenes, so all four slots are
  // genuinely held - which is the saturation the deadlock needs, and makes it
  // deterministic rather than a timing gamble.
  const store = new SqliteStore(":memory:");
  store.migrate();
  /** Serves the `video/id` API with a date, so hydration really fetches. */
  const fetcher: Fetcher = {
    fetch: async () => new Response("{}", { status: 200 }),
    text: async () => "",
    json: async <T>() =>
      [{ id: "x", title: "Marfe", length_sec: 2138, added: "2026-03-05 00:00:00" }] as T,
  };
  const scenes = ["s1", "s2", "s3", "s4"].map((id) =>
    makeMatchScene({
      id: `test:${id}`,
      title: "Marfe takes it deep",
      performers: ["Marfe okkk"],
      releaseDate: "2026-03-04",
      durationSec: 2138,
    }),
  );
  try {
    for (const id of ["a", "b", "c", "d"]) {
      store.upsertPoolVideo({
        id,
        uploader: "Vovick17",
        title: `Marfe compilation ${id}`,
        added: null,
        // A duration but no date: the exact row shape that makes hydration
        // issue a request rather than short-circuit from the index.
        durationSec: 2138,
        hydratedAt: "2026-03-10T00:00:00.000Z",
        views: null,
      });
    }
    const gathered = await withDeadline(
      mapWithConcurrency(
        scenes,
        (scene) =>
          gatherPoolSurvivors(
            scene,
            {
              store,
              fetcher,
              uploaders: ["Vovick17"],
              durationToleranceSec: 2,
              dateWindowDays: 90,
              log: () => {},
            },
            NOW,
          ),
        4,
      ),
      5_000,
      "gatherPoolSurvivors deadlocked the shared fetch pool",
    );
    assert.equal(gathered.length, 4);
    for (const [index, result] of gathered.entries()) {
      assert.equal(
        result.candidates.length,
        4,
        `scene ${index} hydrated every survivor rather than deadlocking`,
      );
    }
  } finally {
    store.close();
  }
});

/** A card whose only date is the given one, or none at all. */
function walkCard(id: string, date?: string): string {
  return (
    `<div class="mb"><a href="/video-${id}/slug/"><img alt="Scene ${id}" /></a>` +
    `<p class="mbstats">${date ?? ""}<span class="mbtim" title="Duration">10:00</span></p></div>`
  );
}
const walkPage = (ids: string[], date?: string): string =>
  ids.map((id) => walkCard(id, date)).join("\n");

test("an account whose count is not a multiple of the page size still reaches the end", async () => {
  // The short-page break compared against a HARD-CODED `12`, so it fired on the
  // final short page - which is exactly where the walk legitimately ends - and
  // then `break`ed WITHOUT setting `reachedEnd`. The 404 that would have set it
  // was never fetched, so for every account whose video count is not an exact
  // multiple of the page size the absence prune never ran and upstream deletions
  // were never corrected. The page size is now measured off page 1 and the
  // short-page test sets the flag.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const index = (pages: Record<number, string>, maxPages?: number) =>
    indexPool({
      store,
      fetcher: textFetcher(pages),
      now: NOW,
      uploaders: ["Vovick17"],
      windowDays: 90,
      fullRewalkDays: 7,
      log: () => {},
      ...(maxPages !== undefined ? { maxPages } : {}),
    });
  try {
    // Five rows in the index; the listing holds 7. `g` and `h` were deleted
    // upstream and `a` and `b` were never there.
    for (const id of ["a", "b", "c", "d", "e"]) {
      store.upsertPoolVideo({
        id,
        uploader: "Vovick17",
        title: id,
        added: null,
        durationSec: 600,
        hydratedAt: "2026-03-10T00:00:00.000Z",
        views: null,
      });
    }
    // Page 1 is a FULL page of 12; page 2 holds the 7 that end the account, so
    // the count is not a multiple of the page size.
    const report = await index({
      1: walkPage(Array.from({ length: 12 }, (_, i) => `q1${i}z`)),
      2: walkPage(["c", "d", "e", "f", "g", "h", "i"]),
    });
    assert.equal(report.uploaders[0]!.pagesFetched, 2);
    assert.equal(
      report.uploaders[0]!.endOfListing,
      true,
      "a short final page is the end of the listing, not a truncation",
    );
    assert.equal(report.uploaders[0]!.pruneSkipped, undefined);
    assert.equal(report.uploaders[0]!.pruned, 2, "a and b were genuinely deleted upstream");
    assert.equal(store.poolVideoCount(), 19, "12 on page 1 plus the 7 that end the account");

    // And the cadence is stamped, because the re-walk was complete.
    assert.equal(store.getPoolMeta(POOL_FULL_REWALK_KEY), NOW.toISOString());
  } finally {
    store.close();
  }
});

test("a walk truncated at the maxPages ceiling neither prunes nor stamps the cadence", async () => {
  // Two failure modes in one, because they are the same failure: the walk never
  // saw the end of the listing, so (a) nothing may be deleted, and (b) the
  // re-walk cadence must NOT be stamped. Stamping it anyway defers the prune by
  // a whole `fullRewalkDays`, so a listing that stays just past a stop condition
  // silently stops correcting deletions forever.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const index = (pages: Record<number, string>, maxPages: number) =>
    indexPool({
      store,
      fetcher: textFetcher(pages),
      now: NOW,
      uploaders: ["Vovick17"],
      windowDays: 90,
      fullRewalkDays: 7,
      maxPages,
      log: () => {},
    });
  try {
    for (const id of ["a", "b", "c"]) {
      store.upsertPoolVideo({
        id,
        uploader: "Vovick17",
        title: id,
        added: null,
        durationSec: 600,
        hydratedAt: "2026-03-10T00:00:00.000Z",
        views: null,
      });
    }
    // Every page is FULL, so the short-page test never fires, and page 3 does not
    // exist - but the ceiling stops the walk on page 2 before the 404 is reached.
    const full = (prefix: string) =>
      walkPage(Array.from({ length: 12 }, (_, i) => `${prefix}${i}z`));
    const truncated = await index({ 1: full("p1"), 2: full("p2") }, 2);
    assert.equal(
      truncated.uploaders[0]!.endOfListing,
      false,
      "the ceiling is not the end of the listing",
    );
    assert.equal(truncated.uploaders[0]!.pruned, 0, "nothing may be deleted on a truncated walk");
    assert.equal(
      truncated.uploaders[0]!.pruneSkipped,
      true,
      "the skip is reported, so /api/runs shows it rather than only a log line",
    );
    assert.equal(
      store.getPoolMeta(POOL_FULL_REWALK_KEY),
      null,
      "an incomplete re-walk must not consume the cadence",
    );
    assert.equal(store.poolVideoCount(), 27, "a, b and c survive the skipped prune");

    // A later complete walk then prunes and stamps as normal, which is what
    // makes withholding the cadence worth anything.
    const completed = await index({ 1: walkPage(["c", "d", "e"]) }, 2);
    assert.equal(completed.uploaders[0]!.endOfListing, true);
    assert.equal(completed.uploaders[0]!.pruneSkipped, undefined);
    assert.ok(
      completed.uploaders[0]!.pruned > 0,
      "the withheld prune runs as soon as a walk actually reaches the end",
    );
    assert.equal(store.getPoolMeta(POOL_FULL_REWALK_KEY), NOW.toISOString());
    assert.deepEqual(
      store
        .poolVideosForUploader("Vovick17")
        .map((row) => row.id)
        .sort(),
      ["c", "d", "e"],
    );
  } finally {
    store.close();
  }
});

test("onUploader reports one finished account at a time, failures included", async () => {
  // The pool index is the longest cold-start phase and the dashboard's
  // "Indexing the trusted pool" caption comes from this callback. It has to fire
  // for an account that FAILED too: a bar that stops at 2 of 4 because the third
  // account threw would read as a hang rather than as a failure.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const seen: Array<[number, number, string]> = [];
  // One account 404s, because the walk cannot start at all for it.
  const base = textFetcher({
    1: walkPage(["a", "b"], "2026-03-08"),
    2: walkPage(["c"], "2026-03-08"),
  });
  const gone: Fetcher = {
    fetch: (url, options) =>
      url.includes("/broken/")
        ? Promise.reject(new Error("account is gone"))
        : base.fetch(url, options),
    text: (url, options) =>
      url.includes("/broken/")
        ? Promise.reject(new Error("account is gone"))
        : base.text(url, options),
    json: <T>(url: string, options?: Parameters<Fetcher["json"]>[1]) => base.json<T>(url, options),
  };
  const report = await indexPool({
    store,
    fetcher: gone,
    now: NOW,
    uploaders: ["Vovick17", "broken"],
    windowDays: 90,
    fullRewalkDays: 7,
    log: () => {},
    onUploader: (done, total, uploader) => seen.push([done, total, uploader]),
  });
  assert.deepEqual(seen, [
    [1, 2, "Vovick17"],
    [2, 2, "broken"],
  ]);
  assert.equal(report.ok, false, "the second account failed, and the callback still fired");
  assert.equal(report.uploaders.length, 2);
  store.close();
});

test("indexing zero accounts is a no-op that still reports nothing", async () => {
  // The degenerate shape of the same loop: an empty uploaders list must not
  // divide by zero, hang, or announce a total that will never be reached.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const seen: Array<[number, number, string]> = [];
  const report = await indexPool({
    store,
    fetcher: textFetcher({}),
    now: NOW,
    uploaders: [],
    windowDays: 90,
    fullRewalkDays: 7,
    log: () => {},
    onUploader: (done, total, uploader) => seen.push([done, total, uploader]),
  });
  assert.deepEqual(seen, []);
  assert.equal(report.totalIndexed, 0);
  assert.equal(report.ok, true, "no account attempted, so nothing failed");
  store.close();
});

// ------------------------------------------------------- the views tiebreak

test("a hydrated row's view count is persisted, and survives the next listing walk", () => {
  // The regression this guards is silent and total: `pool_videos` had no `views`
  // column and `hydrate()`'s short-circuit returned no `views` field, so every
  // fully-indexed row reached `pickMatch` with `views: null`. `rank` then falls
  // through to LAG, so a multi-survivor shortlist was ordered by how close the
  // upload was to the release date rather than by popularity - and the plan's
  // step 4 ("pick the highest view count") was not being applied on the rung
  // that produced 45 of 46 links. Nothing failed; the rule was simply not
  // running.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    store.upsertPoolVideo({
      id: "abc",
      uploader: "Vovick17",
      title: "Marfe compilation",
      added: null,
      durationSec: 2138,
      hydratedAt: null,
      views: null,
    });
    store.setPoolHydration("abc", "Vovick17", 2138, "2026-03-05 11:22:33", NOW.toISOString(), 4231);
    assert.equal(store.poolVideosForUploader("Vovick17")[0]!.views, 4231);

    // A listing walk supplies no count, and must not blank the one hydration
    // paid a network request to learn. `upsertPoolVideo` COALESCEs for the same
    // reason it COALESCEs the date.
    store.upsertPoolVideo({
      id: "abc",
      uploader: "Vovick17",
      title: "Marfe compilation",
      added: "2026-03-05T11:22:33.000Z",
      durationSec: 2138,
      hydratedAt: NOW.toISOString(),
      views: null,
    });
    assert.equal(
      store.poolVideosForUploader("Vovick17")[0]!.views,
      4231,
      "a later walk with no count must not erase a known one",
    );

    // And shorthand forms are normalised to a number on the way in, so a stored
    // "1.2k" and a stored 1200 rank identically.
    store.setPoolHydration("abc", "Vovick17", 2138, null, NOW.toISOString(), null);
    assert.equal(store.poolVideosForUploader("Vovick17")[0]!.views, 4231, "null is COALESCEd");
  } finally {
    store.close();
  }
});

test("a pre-migration row fetches its missing view count once, then takes the fast path", async () => {
  // Migration 0003 adds a nullable column, so every old row starts with views
  // NULL. If `hydrate()` short-circuited on date+duration alone, those rows
  // would stay NULL forever and the view tiebreak would remain upload lag in
  // production. The missing count must therefore force one `video/id` request,
  // and after that request the normal short-circuit must resume.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const scene = makeMatchScene({
    id: "test:legacy-views",
    title: "Marfe compilation",
    performers: ["Marfe"],
    releaseDate: "2026-03-04",
    durationSec: 2138,
  });
  let requests = 0;
  const fetcher: Fetcher = {
    fetch: async () => new Response(""),
    text: async () => "",
    json: async <T>() => {
      requests += 1;
      return {
        id: "legacy",
        title: "Marfe compilation",
        url: "https://www.eporner.com/video-legacy/",
        embed: "https://www.eporner.com/embed/legacy/",
        length_sec: 2138,
        added: "2026-03-05 11:22:33",
        views: 4321,
      } as T;
    },
  };
  try {
    store.upsertPoolVideo({
      id: "legacy",
      uploader: "Vovick17",
      title: "Marfe compilation",
      added: "2026-03-05T11:22:33.000Z",
      durationSec: 2138,
      hydratedAt: NOW.toISOString(),
      views: null,
    });
    const deps = {
      store,
      fetcher,
      uploaders: ["Vovick17"],
      durationToleranceSec: 1,
      dateWindowDays: 7,
      log: () => {},
    };

    const first = await gatherPoolSurvivors(scene, deps, NOW);
    assert.equal(first.candidates[0]?.views, 4321);
    assert.equal(requests, 1, "legacy row hydrated once");
    assert.equal(store.poolVideosForUploader("Vovick17")[0]?.views, 4321);

    const second = await gatherPoolSurvivors(scene, deps, NOW);
    assert.equal(second.candidates[0]?.views, 4321);
    assert.equal(requests, 1, "persisted count restores the no-network fast path");
  } finally {
    store.close();
  }
});

test("the pool rung breaks a same-tier tie on views, not on upload proximity", async () => {
  // The end-to-end version of the guard above: two fully-indexed rows, same
  // identity tier, and the LESS popular one is much closer to the release date.
  // With `views` reaching the matcher the popular one wins; with it missing the
  // lag comparator would decide, and the popular one would lose.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const scene = makeMatchScene({
    id: "test:views",
    title: "Marfe takes it deep",
    performers: ["Marfe"],
    releaseDate: "2026-03-04",
    durationSec: 2138,
  });
  const row = (over: { id: string; added: string; views: number }) => ({
    id: over.id,
    uploader: "Vovick17",
    // Same title, so both are the same identity tier, and the same stem - the
    // collapse must not hide the comparison behind a group.
    title: "Marfe compilation 0304",
    added: over.added,
    durationSec: 2138,
    hydratedAt: NOW.toISOString(),
    views: over.views,
  });
  try {
    // `popular` is one day after the release; `close` is the same day. Lag
    // prefers `close` by a whole day.
    store.upsertPoolVideo(row({ id: "popular", added: "2026-03-05T12:00:00.000Z", views: 90000 }));
    store.upsertPoolVideo(row({ id: "close", added: "2026-03-04T01:00:00.000Z", views: 12 }));

    const match = await createPoolLookup({
      store,
      fetcher: {
        fetch: async () => new Response(""),
        text: async () => "",
        json: async <T>() => ({}) as T,
      },
      uploaders: ["Vovick17"],
      durationToleranceSec: 1,
      dateWindowDays: 7,
      log: () => {},
    })(scene, NOW);

    assert.equal(match?.videoId, "popular", "the view count decided, not the upload date");
    assert.equal(match?.rejected, null);
  } finally {
    store.close();
  }
});

test("the pool rung refuses a winner whose title names nobody", async () => {
  // The gate, end to end. A row that clears duration and date but carries no
  // identity evidence is not a link: the rung reports no-match so the LADDER can
  // move to the next tube, rather than writing a confident wrong URL. Before
  // this, 36 of 46 live links were exactly this case and every one of them was
  // the wrong video.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const scene = makeMatchScene({
    id: "test:gate",
    title: "Brazilian ebony hot wife, Vivian Fernandes",
    performers: ["Vivian Fernandes"],
    releaseDate: "2026-09-26",
    durationSec: 1847,
  });
  try {
    store.upsertPoolVideo({
      id: "decoy",
      uploader: "Vovick17",
      title: "Aceita Dupla Penetracao",
      added: "2026-09-27T12:00:00.000Z",
      durationSec: 1847,
      hydratedAt: NOW.toISOString(),
      views: 6118,
    });
    const match = await createPoolLookup({
      store,
      fetcher: {
        fetch: async () => new Response(""),
        text: async () => "",
        json: async <T>() => ({}) as T,
      },
      uploaders: ["Vovick17"],
      durationToleranceSec: 1,
      dateWindowDays: 7,
      log: () => {},
    })(scene, NOW);
    assert.equal(match?.url, "", "no named candidate, so no link");
    assert.equal(match?.rejected, "none", "date passed; identity is what rejected the candidate");
    // It was counted as considered and it cleared duration - the gate is what
    // rejected it, not the cheap filters.
    assert.equal(match?.durationPassed, 1);
    assert.equal(match?.fallbackCandidates.length, 1);
    assert.equal(match?.fallbackCandidates[0]?.views, 6118);
  } finally {
    store.close();
  }
});

test("hydration cap resumes fairly and reports an incomplete search", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const scene = makeMatchScene({
    id: "test:late-pool-candidate",
    title: "Marfe takes it deep",
    performers: ["Marfe"],
    releaseDate: "2026-03-04",
    durationSec: 2138,
  });
  const fetcher: Fetcher = {
    fetch: async () => new Response(""),
    text: async () => "",
    json: async <T>() => ({}) as T,
  };
  try {
    for (let index = 0; index < 41; index += 1) {
      store.upsertPoolVideo({
        id: `candidate${index}`,
        uploader: "Vovick17",
        title: index === 40 ? "Marfe compilation" : `Unrelated compilation ${index}`,
        added: "2026-03-05T12:00:00.000Z",
        durationSec: 2138,
        hydratedAt: NOW.toISOString(),
        views: 100,
      });
    }
    const lookup = createPoolLookup({
      store,
      fetcher,
      uploaders: ["Vovick17"],
      durationToleranceSec: 1,
      dateWindowDays: 7,
      maxHydrations: 40,
      log: () => {},
    });

    const first = await lookup(scene, NOW);
    assert.equal(first?.videoId, "");
    assert.equal(first?.hydrationCapped, true);
    assert.equal(first?.omittedCandidates, 1);
    assert.equal(first?.rejected, "incomplete", "the first pass is not an exhaustive no-match");

    const second = await lookup(scene, new Date(NOW.getTime() + 1_000));
    assert.equal(second?.videoId, "candidate40");
    assert.equal(second?.hydrationCapped, true, "the remaining tail is still reported");
    assert.equal(second?.omittedCandidates, 1);
  } finally {
    store.close();
  }
});

test("a valid late candidate is linked by a later run on the same saved state", async () => {
  // The undated working set is the production shape - the profile listing
  // carries a duration but no date - and more candidates than the cap is the
  // ordinary case, not an edge. Two runs, with the database closed and reopened
  // in between, so the second run reads only what the first one persisted.
  const directory = mkdtempSync(join(tmpdir(), "liszt-pool-late-"));
  const databasePath = join(directory, "pool.db");
  let store = new SqliteStore(databasePath);
  store.migrate();
  const scene = makeMatchScene({
    id: "test:late-undated-candidate",
    title: "Marfe takes it deep",
    performers: ["Marfe"],
    releaseDate: "2026-03-04",
    durationSec: 2138,
  });
  const requested: string[] = [];
  const fetcher: Fetcher = {
    fetch: async () => new Response(""),
    text: async () => "",
    json: async <T>(url: string): Promise<T> => {
      const id = new URL(url).searchParams.get("id")!;
      requested.push(id);
      return [
        {
          id,
          title: id === "latevalid" ? "Marfe compilation" : `Unrelated compilation ${id}`,
          length_sec: 2138,
          added: "2026-03-05 12:00:00",
          views: "1,234",
          uploader: "Vovick17",
        },
      ] as unknown as T;
    },
  };
  try {
    for (let index = 0; index < 45; index += 1) {
      store.upsertPoolVideo({
        id: index === 44 ? "latevalid" : `candidate${index}`,
        uploader: "Vovick17",
        title: index === 44 ? "Marfe compilation" : `Unrelated compilation ${index}`,
        added: null,
        durationSec: 2138,
        hydratedAt: null,
        views: null,
      });
    }
    const lookup = () =>
      createPoolLookup({
        store,
        fetcher,
        uploaders: ["Vovick17"],
        durationToleranceSec: 1,
        dateWindowDays: 7,
        maxHydrations: 40,
        log: () => {},
      });
    const first = await lookup()(scene, NOW);
    assert.equal(first?.rejected, "incomplete", "the first run cannot answer exhaustively");
    assert.equal(first?.omittedCandidates, 5);
    assert.equal(first?.videoId, "", "the valid candidate was past the cut");
    assert.equal(requested.length, 40, "requests stay bounded by the cap");

    store.close();
    store = new SqliteStore(databasePath);
    store.migrate();
    requested.length = 0;
    const second = await lookup()(scene, new Date(NOW.getTime() + 1_800_000));
    assert.equal(second?.videoId, "latevalid", "the rotation reached it on the next run");
    assert.deepEqual(
      requested,
      ["candidate40", "candidate41", "candidate42", "candidate43", "latevalid"],
      "only the deferred tail was hydrated, and the rest of the run was not paid for again",
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

for (const durationRange of [undefined, { minSec: 2137, maxSec: 2140 }]) {
  test(`dated rows outside the duration ${durationRange ? "range" : "band"} do not starve undated rows`, async () => {
    // More dated rows in the window than the scan examines per account. They all
    // fail the duration half of the gate, which costs nothing to reject - but they
    // do not rotate, so before the band was pushed into SQL they took the whole
    // scan budget on every run and the undated rows behind them were never read
    // at all. A valid candidate could not be hydrated in any run, ever.
    const store = new SqliteStore(":memory:");
    store.migrate();
    const scene = makeMatchScene({
      id: "test:band-starvation",
      title: "Marfe takes it deep",
      performers: ["Marfe"],
      releaseDate: "2026-03-04",
      durationSec: durationRange ? null : 2138,
      ...(durationRange ? { durationRange } : {}),
    });
    const requested: string[] = [];
    const fetcher: Fetcher = {
      fetch: async () => new Response(""),
      text: async () => "",
      json: async <T>(url: string): Promise<T> => {
        const id = new URL(url).searchParams.get("id")!;
        requested.push(id);
        return [
          {
            id,
            title: "Marfe compilation",
            length_sec: 2138,
            added: "2026-03-05 12:00:00",
            views: 5,
          },
        ] as unknown as T;
      },
    };
    try {
      for (let index = 0; index < 800; index += 1) {
        store.upsertPoolVideo({
          id: `dated${index}`,
          uploader: "Vovick17",
          title: `Unrelated dated ${index}`,
          added: "2026-03-05T12:00:00.000Z",
          durationSec: 600,
          hydratedAt: NOW.toISOString(),
          views: 10,
        });
      }
      store.upsertPoolVideo({
        id: "undatedvalid",
        uploader: "Vovick17",
        title: "Marfe compilation",
        added: null,
        durationSec: 2138,
        hydratedAt: null,
        views: null,
      });

      const match = await createPoolLookup({
        store,
        fetcher,
        uploaders: ["Vovick17"],
        durationToleranceSec: 1,
        dateWindowDays: 7,
        log: () => {},
      })(scene, NOW);
      assert.equal(
        match?.videoId,
        "undatedvalid",
        "the working set was reachable, not crowded out",
      );
      assert.deepEqual(
        requested,
        ["undatedvalid"],
        "one request, and not one per rejected dated row",
      );
      assert.equal(match?.candidatesConsidered, 1, "the rejected rows never entered the scan");
    } finally {
      store.close();
    }
  });
}

test("hydration attempts rotate after failures within a run with a fixed time", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const now = new Date(NOW);
  const scene = makeMatchScene({
    id: "test:pool-attempt-order",
    releaseDate: "2026-03-04",
    durationSec: 2138,
  });
  const attemptedIds: string[] = [];
  const attemptedTimes: string[] = [];
  const fetcher: Fetcher = {
    fetch: async () => new Response(""),
    text: async () => "",
    json: async <T>(url: string): Promise<T> => {
      const id = new URL(url).searchParams.get("id");
      const row = store.poolVideosForUploader("Vovick17").find((row) => row.id === id);
      assert.ok(row?.hydrationAttemptedAt);
      attemptedIds.push(row.id);
      attemptedTimes.push(row.hydrationAttemptedAt);
      throw new Error("temporary hydration failure");
    },
  };
  try {
    for (let index = 0; index < 3; index += 1) {
      store.upsertPoolVideo({
        id: `candidate${index}`,
        uploader: "Vovick17",
        title: "Marfe compilation",
        added: null,
        durationSec: 2138,
        hydratedAt: null,
        views: null,
      });
    }
    for (let pass = 0; pass < 3; pass += 1) {
      const gathered = await gatherPoolSurvivors(
        scene,
        {
          store,
          fetcher,
          uploaders: ["Vovick17"],
          durationToleranceSec: 1,
          dateWindowDays: 7,
          maxHydrations: 2,
          log: () => {},
        },
        now,
      );
      assert.equal(gathered.durationPassed, 3);
      assert.equal(gathered.capped, true);
      assert.deepEqual(gathered.candidates, []);
    }
    assert.deepEqual(attemptedIds, [
      "candidate0",
      "candidate1",
      "candidate2",
      "candidate0",
      "candidate1",
      "candidate2",
    ]);
    assert.equal(attemptedTimes[0], now.toISOString());
    for (let index = 1; index < attemptedTimes.length; index += 1) {
      assert.ok(attemptedTimes[index]! > attemptedTimes[index - 1]!);
    }
    assert.equal(now.toISOString(), NOW.toISOString(), "the run time stays unchanged");
  } finally {
    store.close();
  }
});

test("duration-rejected undated rows rotate past the SQL cap without hydration attempts", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const now = new Date(NOW);
  const scene = makeMatchScene({
    id: "test:undated-scan-progress",
    releaseDate: "2026-03-04",
    durationSec: 2138,
  });
  const attemptedIds: string[] = [];
  const fetcher: Fetcher = {
    fetch: async () => new Response(""),
    text: async () => "",
    json: async <T>(url: string): Promise<T> => {
      attemptedIds.push(new URL(url).searchParams.get("id")!);
      throw new Error("temporary hydration failure");
    },
  };
  const deps = {
    store,
    fetcher,
    uploaders: ["Vovick17"],
    durationToleranceSec: 1,
    dateWindowDays: 7,
    maxConsidered: 2,
    maxHydrations: 1,
    log: () => {},
  };
  try {
    for (const id of ["rejected0", "rejected1", "matching0", "matching1", "matching2"]) {
      store.upsertPoolVideo({
        id,
        uploader: "Vovick17",
        title: "Marfe compilation",
        added: null,
        durationSec: id.startsWith("rejected") ? 600 : 2138,
        hydratedAt: null,
        views: null,
      });
    }
    const first = await gatherPoolSurvivors(scene, deps, now);
    assert.equal(first.considered, 2);
    assert.equal(first.durationPassed, 0);
    assert.deepEqual(attemptedIds, [], "rejections cost no hydration requests");
    assert.deepEqual(
      store.poolVideosUndated("Vovick17", 2).map((row) => row.id),
      ["matching0", "matching1"],
      "duration rejections no longer fill the SQL limit",
    );
    for (let pass = 0; pass < 4; pass += 1) {
      const gathered = await gatherPoolSurvivors(scene, deps, now);
      assert.equal(gathered.considered, 2);
      assert.ok(gathered.durationPassed >= 1);
    }
    assert.deepEqual(
      attemptedIds,
      ["matching0", "matching1", "matching2", "matching0"],
      "deferred survivors and failed requests rotate even with one fixed run time",
    );
    for (const row of store.poolVideosUndated("Vovick17")) {
      if (!row.id.startsWith("rejected")) continue;
      assert.equal(row.hydrationAttemptedAt, null);
      assert.equal(row.hydratedAt, null);
    }
    await gatherPoolSurvivors({ ...scene, durationSec: 600 }, deps, now);
    assert.equal(attemptedIds.at(-1), "rejected0", "rejections remain eligible for other scenes");
  } finally {
    store.close();
  }
});

for (const durationSec of [600, 2138]) {
  test(`pool progress stays ahead of persisted scans across sync cycles (${durationSec})`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "liszt-pool-progress-"));
    const databasePath = join(directory, "pool.db");
    let store = new SqliteStore(databasePath);
    store.migrate();
    const scene = makeMatchScene({
      id: "test:persisted-pool-progress",
      releaseDate: "2026-03-04",
      durationSec: 2138,
    });
    const attemptedIds: string[] = [];
    const fetcher: Fetcher = {
      fetch: async () => new Response(""),
      text: async () => "",
      json: async <T>(url: string): Promise<T> => {
        attemptedIds.push(new URL(url).searchParams.get("id")!);
        throw new Error("temporary hydration failure");
      },
    };
    try {
      for (let index = 0; index < 6; index += 1) {
        const id = `row${index}`;
        store.upsertPoolVideo({
          id,
          uploader: "Vovick17",
          title: "Marfe compilation",
          added: null,
          durationSec,
          hydratedAt: null,
          views: null,
        });
        store.markPoolUndatedScan(
          id,
          "Vovick17",
          new Date(NOW.getTime() + 100 + index).toISOString(),
        );
      }
      // A fresh store simulates resuming after a restart with saved progress
      // ahead of the next run's clock. Reuse it for subsequent sync cycles.
      store.close();
      store = new SqliteStore(databasePath);
      store.migrate();
      for (const [pass, timeOffset] of [1, 2, -1000].entries()) {
        const now = new Date(NOW.getTime() + timeOffset);
        await gatherPoolSurvivors(
          scene,
          {
            store,
            fetcher,
            uploaders: ["Vovick17"],
            durationToleranceSec: 1,
            dateWindowDays: 7,
            maxConsidered: 2,
            maxHydrations: 2,
            log: () => {},
          },
          now,
        );
        const nextIndex = ((pass + 1) * 2) % 6;
        assert.deepEqual(
          store.poolVideosUndated("Vovick17", 2).map((row) => row.id),
          [`row${nextIndex}`, `row${nextIndex + 1}`],
          "each scan advances beyond the visited rows, even when the clock moves back",
        );
        assert.equal(now.getTime(), NOW.getTime() + timeOffset);
      }
      assert.deepEqual(
        attemptedIds,
        durationSec === 2138 ? ["row0", "row1", "row2", "row3", "row4", "row5"] : [],
      );
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("duration range SQL keeps dated boundary values and missing durations", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    const durations = [599, 600, 601, 604, 605, 606, null];
    for (const [index, durationSec] of durations.entries()) {
      store.upsertPoolVideo({
        id: `boundary${index}`,
        uploader: "Vovick17",
        title: "Test release",
        added: "2026-03-05T12:00:00.000Z",
        durationSec,
        hydratedAt: null,
        views: null,
      });
    }
    const gathered = await gatherPoolSurvivors(
      makeMatchScene({
        id: "test:duration-boundaries",
        releaseDate: "2026-03-04",
        durationSec: null,
        durationRange: { minSec: 601, maxSec: 604 },
      }),
      {
        store,
        fetcher: textFetcher({}),
        uploaders: ["Vovick17"],
        durationToleranceSec: 1,
        dateWindowDays: 7,
        maxHydrations: 0,
        log() {},
      },
      NOW,
    );
    assert.equal(gathered.considered, 5);
    assert.equal(gathered.durationPassed, 5);
    assert.deepEqual(gathered.survivorDurations, [600, 601, 604, 605]);
  } finally {
    store.close();
  }
});
