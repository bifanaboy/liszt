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
} from "../src/tubes/eporner-pool.ts";
import { makeMatchScene } from "./helpers.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";

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
