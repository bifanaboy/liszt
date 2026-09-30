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
import { readFileSync } from "node:fs";
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
} from "../src/tubes/eporner-pool.ts";
import { makeMatchScene } from "./helpers.ts";
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
    json: async <T>() => ({} as T),
  };
}

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "eporner-profile.html");
const NOW = new Date("2026-03-10T00:00:00Z");

test("pagination is path-based: the query form 301s back to page 1", () => {
  // Verified live: `/uploaded-videos/?page=2` answers 301; `/uploaded-videos/2/`
  // answers 200 with different videos.
  assert.equal(profileListingUrl("Vovick17", 1), "https://www.eporner.com/profile/Vovick17/uploaded-videos/");
  assert.equal(profileListingUrl("Vovick17", 2), "https://www.eporner.com/profile/Vovick17/uploaded-videos/2/");
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
  const good = { id: "a", uploader: "Vovick17", title: "Marfe compilation 0304", added: null, durationSec: 2138, hydratedAt: null };
  // Right duration: survives, whatever the title and whatever the date.
  assert.equal(preFilter(scene, good, { durationToleranceSec: 2 }), true);
  // Right duration, no identity at all: STILL survives. The pre-filter no
  // longer pre-judges identity - it ranks later, in `pickMatch`.
  assert.equal(preFilter(scene, { ...good, title: "unrelated clip" }, { durationToleranceSec: 2 }), true);
  // Right identity, wrong duration: rejected without any network call.
  assert.equal(preFilter(scene, { ...good, durationSec: 2500 }, { durationToleranceSec: 2 }), false);
  // Boundary: exactly at the tolerance is inside, one second past is not.
  assert.equal(preFilter(scene, { ...good, durationSec: 2140 }, { durationToleranceSec: 2 }), true);
  assert.equal(preFilter(scene, { ...good, durationSec: 2141 }, { durationToleranceSec: 2 }), false);
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
    });
    assert.equal(store.poolUndatedCount(), 1);

    store.setPoolHydration("abc", "Vovick17", 2138, "2026-03-05 11:22:33", "2026-03-10T00:00:00.000Z");
    const [row] = store.poolVideosForUploader("Vovick17");
    assert.equal(row!.added, "2026-03-05T11:22:33.000Z", "normalised so the TEXT range scan sorts correctly");
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
      id: "abc", uploader: "Vovick17", title: "t", added: "2026-03-05T11:22:33.000Z",
      durationSec: 2138, hydratedAt: null,
    });
    // The naive zoneless format does not sort against an ISO bound; this is the
    // regression that `toIsoUtc` at the write boundary prevents.
    const inWindow = store.poolVideosInWindow("Vovick17", "2026-03-04T00:00:00.000Z", "2026-03-12T00:00:00.000Z");
    assert.equal(inWindow.length, 1);
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
        id, uploader: "Vovick17", title: id, added: null,
        durationSec: 600, hydratedAt: "2026-03-10T00:00:00.000Z",
      });
    }
    const all = store.poolVideosUndated("Vovick17");
    assert.deepEqual(all.map((row) => row.id), ["newest", "middle", "oldest"]);
    assert.deepEqual(
      store.poolVideosUndated("Vovick17", 2).map((row) => row.id),
      ["newest", "middle"],
      "the cap keeps the newest, not an arbitrary subset",
    );
    assert.deepEqual(store.poolVideosUndated("Vovick17", 0), []);
    // A dated row is not in this set at all.
    store.setPoolHydration("middle", "Vovick17", 600, "2026-03-05 00:00:00", "2026-03-10T00:00:00.000Z");
    assert.deepEqual(
      store.poolVideosUndated("Vovick17").map((row) => row.id),
      ["newest", "oldest"],
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
        id, uploader: "Vovick17", title: id, added: null,
        durationSec: 600, hydratedAt: "2026-03-10T00:00:00.000Z",
      });
    }

    // COMPLETE walk: page 1 is full (a short page is itself a stop), and page 2
    // answers 404, so the end of the listing was genuinely reached. `d` and `e`
    // were deleted upstream, and saying so is the whole point of the re-walk.
    const complete = await index({ 1: page(["a", "b", "c", "f", "g", "h", "i", "j", "k", "l", "m", "n"]) });
    assert.equal(complete.ok, true);
    assert.equal(complete.uploaders[0]!.endOfListing, true);
    assert.equal(complete.uploaders[0]!.pruned, 2, "d and e were genuinely deleted upstream");
    assert.equal(store.poolVideoCount(), 12);

    // TRUNCATED walk: every card is dated far in the past, so the window stop
    // fires on page 1 and the rest of the account is never looked at.
    for (const id of ["o", "p", "q"]) {
      store.upsertPoolVideo({
        id, uploader: "Vovick17", title: id, added: null,
        durationSec: 600, hydratedAt: "2026-03-10T00:00:00.000Z",
      });
    }
    const truncated = await index({
      1: page(["a", "b", "c", "f", "g", "h", "i", "j", "k", "l", "m", "n"], "Mar 1, 2019"),
      2: page(["o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z"], "Mar 1, 2019"),
    });
    assert.equal(truncated.ok, true);
    assert.equal(truncated.uploaders[0]!.endOfListing, false, "the walk stopped early, not at the end");
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
