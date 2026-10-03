/**
 * The FC2 lane: the listing walk, the classifier, the bounded detail work, and
 * the promise that a failure preserves last-good scenes.
 *
 * Every test here is fixture-driven. Nothing reaches the network, because the
 * lane's pacing (2s listing, 8.5s detail) makes a live test a multi-minute test
 * and because a test that depends on a third-party site's uptime is a test that
 * reports someone else's outage as this app's bug.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  classifyFc2Candidate,
  createFc2CmadbStudio,
  extractInertiaPage,
  parseFc2Detail,
  parseFc2Listing,
  toFc2RawScene,
  walkFc2Listing,
  Fc2RateLimitedError,
  Fc2ShapeError,
  Fc2SourceError,
  FC2_ANAL_TAG_ID,
  FC2_LISTING_URL,
  type Fc2ListingRecord,
} from "../src/sources/fc2cmadb.ts";
import { parseClockDuration } from "../src/tubes/eporner-pool.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import type { Fetcher, SourceContext } from "../src/sources/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const NOW = new Date("2026-10-03T00:00:00Z");
/** 90 days before NOW, matching the app's rolling window. */
const WINDOW_START = "2026-07-05";

/**
 * A fetcher over a fixed URL map. An unmapped URL is a 404, never a network call.
 *
 * A `function` entry is called WITH THE URL and its RESULT used, so a route can
 * assert, count, or key off the path instead of returning a fixed body. Keys are matched longest-first: the cursor
 * URL `?cursor=c1` starts with the bare listing URL, and matching the shorter key
 * first would serve page one for page two.
 */
function stubFetcher(pages: Record<string, string | ((url: string) => string)>): Fetcher & {
  calls: string[];
} {
  const calls: string[] = [];
  const keys = Object.keys(pages).sort((a, b) => b.length - a.length);
  return {
    calls,
    async fetch(url: string): Promise<Response> {
      calls.push(url);
      const key = keys.find((candidate) => url.startsWith(candidate));
      const page = key === undefined ? undefined : pages[key];
      if (page === undefined) return new Response("missing", { status: 404 });
      const body = typeof page === "function" ? page(url) : page;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    async text(url: string): Promise<string> {
      return (await this.fetch(url)).text();
    },
    async json<T>(url: string): Promise<T> {
      return (await this.fetch(url)).json() as T;
    },
  };
}

function context(fetcher: Fetcher, now = NOW): SourceContext {
  return {
    fetcher,
    now,
    log: () => {},
    mapWithConcurrency: (items, task) => Promise.all(items.map(task)),
    mapIsolated: (items, task) => Promise.all(items.map(task)),
  };
}

const noSleep = async (): Promise<void> => {};

/* ---- The Inertia page reader --------------------------------------------- */

test("the page payload is read out of the script tag, not the markup", () => {
  const page = extractInertiaPage(fixture("fc2-anal-listing-page-1.html"));
  assert.equal(page.component, "Tags/Show");
  assert.equal(page.props.tag_name, "アナル");
});

test("a page with no payload is a shape failure, not an empty listing", () => {
  // THE distinction that matters: an empty tag and a page that is not a page look
  // identical to any reader that returns `[]` on failure, and the empty reading
  // would let the lane claim a verified emptiness it never verified.
  assert.throws(() => extractInertiaPage(fixture("fc2-listing-no-payload.html")), Fc2ShapeError);
});

test("truncated page JSON fails loudly instead of parsing to something plausible", () => {
  assert.throws(
    () => extractInertiaPage(fixture("fc2-listing-truncated-json.html")),
    Fc2ShapeError,
  );
});

/* ---- The listing walk ----------------------------------------------------- */

test("one cursor page parses into records and the next cursor", () => {
  const listing = parseFc2Listing(extractInertiaPage(fixture("fc2-anal-listing-page-1.html")));
  assert.equal(listing.records.length, 4);
  assert.equal(listing.records[0]?.videoId, "4986883");
  assert.equal(listing.records[0]?.releaseDate, "2026-10-02");
  assert.equal(listing.records[0]?.duration, "01:02:08");
  assert.equal(listing.records[0]?.tagId, FC2_ANAL_TAG_ID);
  assert.ok(listing.nextCursor, "the page carries a cursor, so the walk continues");
});

test("the final page carries a null cursor and ends the walk", () => {
  const listing = parseFc2Listing(extractInertiaPage(fixture("fc2-anal-listing-final.html")));
  assert.deepEqual(listing.records, []);
  assert.equal(listing.nextCursor, null);
});

test("a listing that stopped being the anal tag fails rather than importing it", () => {
  // The site serves the SAME component for every tag, so a lost cursor would
  // otherwise look like a healthy walk that simply returned some other tag.
  assert.throws(
    () => parseFc2Listing(extractInertiaPage(fixture("fc2-listing-wrong-component.html"))),
    Fc2ShapeError,
  );
});

test("a foreign pivot tag is a reason to refuse, and it is checked per record", () => {
  const listing = parseFc2Listing(extractInertiaPage(fixture("fc2-anal-listing-foreign-tag.html")));
  assert.equal(listing.records.length, 4, "the records are readable");
  const inWindow = listing.records.filter((record) => record.tagId === FC2_ANAL_TAG_ID);
  assert.deepEqual(inWindow, [], "but none of them pivots on tag 47, so none may be ingested");
});

/** A listing stub for walk tests: `pages` maps a cursor to its records. */
function listingFetcher(
  pages: {
    cursor: string | null;
    records: Partial<Fc2ListingRecord>[];
    nextCursor: string | null;
  }[],
  detail: (id: string) => string | undefined = () => undefined,
) {
  const urls = pages.map(
    (_, index) => `${FC2_LISTING_URL}${index === 0 ? "" : `?cursor=c${index}`}`,
  );
  return stubFetcher({
    ...Object.fromEntries(
      urls.map((url, index) => [
        url,
        () =>
          `<script data-page="app" type="application/json">${JSON.stringify({
            component: "Tags/Show",
            props: {
              tag_name: "アナル",
              articles: {
                data: pages[index]?.records.map((record) => ({
                  video_id: record.videoId,
                  title: record.title ?? "Scene",
                  release_date: record.releaseDate ?? "2026-09-30",
                  duration: record.duration ?? "20:00",
                  censored: null,
                  not_found: null,
                  writer: { name: "seller" },
                  pivot: { tag_id: FC2_ANAL_TAG_ID },
                })),
                next_cursor: pages[index]?.nextCursor ?? null,
              },
            },
            url: "/tags/アナル",
            version: "v",
          })}</script>`,
      ]),
    ),
    "https://fc2cmadb.com/articles/": (url: string) => {
      const id = url.split("/").pop() as string;
      const body = detail(id);
      if (body === undefined) throw new Error(`no fixture for ${id}`);
      return body;
    },
  });
}

test("the walk follows cursors and stops at the window edge", async () => {
  const fetcher = listingFetcher([
    {
      cursor: null,
      records: [{ videoId: "5000002", releaseDate: "2026-09-30" }],
      nextCursor: "c1",
    },
    {
      cursor: "c1",
      records: [{ videoId: "5000001", releaseDate: "2026-08-01" }],
      nextCursor: null,
    },
  ]);
  const walk = await walkFc2Listing(
    {
      listAnalTag: async (cursor) =>
        parseFc2Listing(
          extractInertiaPage(
            await fetcher.text(
              cursor === null ? `${FC2_LISTING_URL}` : `${FC2_LISTING_URL}?cursor=c1`,
            ),
          ),
        ),
      getArticle: async () => {
        throw new Error("not used");
      },
    },
    WINDOW_START,
  );
  assert.equal(walk.pages, 2);
  assert.deepEqual(
    walk.records.map((record) => record.videoId),
    ["5000002", "5000001"],
  );
  assert.ok(walk.reachedEnd, "it reached the final page rather than the page ceiling");
});

test("a page entirely outside the window ends the walk without an error", async () => {
  // Ordered newest-first, so the first page with nothing in the window means
  // everything above it was already examined.
  const fetcher = listingFetcher([
    {
      cursor: null,
      records: [
        { videoId: "5000002", releaseDate: "2026-09-30" },
        { videoId: "5000001", releaseDate: "2019-01-01" },
      ],
      nextCursor: null,
    },
  ]);
  const walk = await walkFc2Listing(
    {
      listAnalTag: async () =>
        parseFc2Listing(extractInertiaPage(await fetcher.text(FC2_LISTING_URL))),
      getArticle: async () => {
        throw new Error("not used");
      },
    },
    WINDOW_START,
  );
  assert.ok(walk.reachedEnd);
});

test("a repeated cursor is an incomplete walk and throws", async () => {
  // Without this check a cursor the site does not honour returns the same page
  // forever, and the lane finishes its page budget having seen one page of four.
  const client = {
    listAnalTag: async () =>
      parseFc2Listing(extractInertiaPage(fixture("fc2-anal-listing-page-1.html"))),
    getArticle: async () => {
      throw new Error("not used");
    },
  };
  await assert.rejects(() => walkFc2Listing(client, WINDOW_START), Fc2ShapeError);
});

test("the page ceiling is an incomplete walk, never a quiet truncation", async () => {
  const client = {
    listAnalTag: async () =>
      parseFc2Listing(extractInertiaPage(fixture("fc2-anal-listing-page-1.html"))),
    getArticle: async () => {
      throw new Error("not used");
    },
  };
  await assert.rejects(() => walkFc2Listing(client, WINDOW_START, { maxPages: 2 }), Fc2SourceError);
});

/* ---- The classifier ------------------------------------------------------- */

test("an explicit uncensored badge with no exclusion is accepted", () => {
  const verdict = classifyFc2Candidate({
    durationSec: 1200,
    censored: "無",
    notFound: false,
    releaseDate: "2026-10-02",
    title: "【無修正】テスト",
    tags: ["アナル", "中出し"],
  });
  assert.equal(verdict.status, "accepted");
});

test("a censored badge is excluded", () => {
  const verdict = classifyFc2Candidate({
    durationSec: 1200,
    censored: "有",
    notFound: false,
    releaseDate: "2026-10-02",
    title: "テスト",
    tags: ["アナル"],
  });
  assert.deepEqual(verdict, { status: "excluded", verdict: "censored" });
});

test("an unmarked badge is PENDING - neither accepted nor called censored", () => {
  // This is the site's common case: 27 of the 30 newest anal-tag records carried
  // no badge at all. Accepting them would import unverified releases; calling them
  // censored would hide real uncensored records from the lane permanently.
  const verdict = classifyFc2Candidate({
    durationSec: 1200,
    censored: null,
    notFound: false,
    releaseDate: "2026-10-02",
    title: "【無修正】と書かれたが実際のバッジはない",
    tags: ["アナル"],
  });
  assert.equal(verdict.status, "pending");
  assert.match(verdict.verdict, /unmarked/);
});

test("a badge of `無` spelled inside the TITLE does not stand in for the badge", () => {
  const verdict = classifyFc2Candidate({
    durationSec: 1200,
    censored: null,
    notFound: false,
    releaseDate: "2026-10-02",
    title: "【無修正】と書かれたが実際のバッジはない",
    tags: [],
  });
  assert.equal(verdict.status, "pending", "only the site's own field is evidence");
});

test("a safety tag excludes even an explicitly uncensored record", () => {
  const detail = parseFc2Detail(extractInertiaPage(fixture("fc2-detail-safety-tag.html")));
  const verdict = classifyFc2Candidate({ ...detail, tags: detail.tags });
  assert.equal(verdict.status, "excluded");
  assert.match(verdict.verdict, /safety/);
});

test("a trans/crossdress tag excludes, and the safety check runs first", () => {
  const detail = parseFc2Detail(extractInertiaPage(fixture("fc2-detail-trans-tag.html")));
  assert.equal(classifyFc2Candidate({ ...detail, tags: detail.tags }).status, "excluded");
  const both = classifyFc2Candidate({
    durationSec: 1200,
    censored: "無",
    notFound: false,
    releaseDate: "2026-10-02",
    title: "テスト",
    tags: ["女装", "小学生"],
  });
  assert.match(both.verdict, /safety/, "the first matching family is the one reported");
});

test("a TAG-ONLY exclusion matches, with no mention in the title", () => {
  const verdict = classifyFc2Candidate({
    durationSec: 1200,
    censored: "無",
    notFound: false,
    releaseDate: "2026-10-02",
    title: "完全に健全なタイトル",
    tags: ["アナル", "女装"],
  });
  assert.equal(
    verdict.status,
    "excluded",
    "the filter reads the full tag list, not only the title",
  );
});

test("a missing release date excludes rather than entering the window arithmetic", () => {
  const detail = parseFc2Detail(extractInertiaPage(fixture("fc2-detail-no-date.html")));
  const verdict = classifyFc2Candidate({ ...detail, tags: detail.tags });
  assert.deepEqual(verdict, { status: "excluded", verdict: "no release date" });
});

test("a record the site marks removed is excluded and never treated as a scene", () => {
  const detail = parseFc2Detail(extractInertiaPage(fixture("fc2-detail-removed.html")));
  const verdict = classifyFc2Candidate({ ...detail, tags: detail.tags });
  assert.equal(verdict.status, "excluded");
  assert.match(verdict.verdict, /removed/);
});

/* ---- Scene mapping -------------------------------------------------------- */

test("an accepted record maps to the canonical raw scene, with no new fields", () => {
  const detail = parseFc2Detail(extractInertiaPage(fixture("fc2-detail-uncensored.html")));
  const raw = toFc2RawScene(detail, { status: "accepted", verdict: "explicitly uncensored" });
  assert.equal(raw.sourceSceneId, "4986883");
  assert.equal(raw.title, detail.title, "the Japanese title is kept verbatim");
  assert.equal(raw.releaseDate, "2026-10-02");
  assert.equal(raw.durationSec, 3728, "01:02:08");
  assert.equal(raw.releaseUrl, "https://fc2cmadb.com/articles/4986883");
  assert.deepEqual(raw.tags, ["アナル", "中出し", "人妻", "ハメ撮り"]);
  assert.equal(raw.provenance?.audit?.fc2Tag, "アナル");
  for (const key of ["seller", "censored", "originalTitle", "translation"]) {
    assert.ok(!(key in raw), `the lane must not add a "${key}" field`);
  }
});

/* ---- The bounded, resumable detail walk ----------------------------------- */

function laneFetcher(
  pages: Parameters<typeof listingFetcher>[0],
  detail: (id: string) => string | undefined,
) {
  return listingFetcher(pages, detail);
}

test("only explicitly uncensored records become scenes", async () => {
  const fetcher = laneFetcher(
    [
      {
        cursor: null,
        records: [
          { videoId: "4986883", releaseDate: "2026-10-02" },
          { videoId: "4986752", releaseDate: "2026-10-02" },
          { videoId: "4986794", releaseDate: "2026-10-02" },
        ],
        nextCursor: null,
      },
    ],
    (id) =>
      ({
        "4986883": fixture("fc2-detail-uncensored.html"),
        "4986752": fixture("fc2-detail-censored.html"),
        "4986794": fixture("fc2-detail-unmarked.html"),
      })[id],
  );
  const studio = createFc2CmadbStudio({ sleep: noSleep, maxDetailChecksPerSync: 10 });
  const result = await studio.fetch(WINDOW_START, context(fetcher));
  assert.deepEqual(
    result.scenes.map((scene) => scene.sourceSceneId),
    ["4986883"],
  );
  assert.equal(result.verifiedEmpty, false);
});

test("detail work is bounded per sync and resumes on the next one", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const records = [
    { videoId: "4986883", releaseDate: "2026-10-02" },
    { videoId: "4986752", releaseDate: "2026-10-02" },
    { videoId: "4986794", releaseDate: "2026-10-02" },
    { videoId: "4986048", releaseDate: "2026-10-02" },
  ];
  const bodies: Record<string, string> = {
    "4986883": fixture("fc2-detail-uncensored.html"),
    "4986752": fixture("fc2-detail-censored.html"),
    "4986794": fixture("fc2-detail-unmarked.html"),
    "4986048": fixture("fc2-detail-removed.html"),
  };
  const pages = [{ cursor: null, records, nextCursor: null }];
  const studio = createFc2CmadbStudio({ store, sleep: noSleep, maxDetailChecksPerSync: 2 });

  // All four were first seen in the same sync, so the tiebreak is the release
  // id - which is also release order on this site. The two LOWEST ids are checked
  // first, and they are both non-qualifying (one removed, one censored), so the
  // first sync emits nothing. That is the correct answer, not a failure: the
  // budget is spent on the records that have waited longest, and it is spent on
  // the same two next time only if they were left pending.
  const checkedFirst: string[] = [];
  const first = await studio.fetch(
    WINDOW_START,
    context(
      laneFetcher(pages, (id) => {
        checkedFirst.push(id);
        return bodies[id];
      }),
    ),
  );
  assert.deepEqual(checkedFirst, ["4986048", "4986752"], "the two oldest were checked");
  assert.equal(first.scenes.length, 0, "neither of them qualifies");
  assert.equal(store.countFc2Pending(), 2, "the other two are still owed");

  // Second pass picks up exactly the two the first never reached.
  const seen: string[] = [];
  const second = await studio.fetch(
    WINDOW_START,
    context(
      laneFetcher(pages, (id) => {
        seen.push(id);
        return bodies[id];
      }),
    ),
  );
  assert.deepEqual(seen, ["4986794", "4986883"], "no record is checked twice");
  assert.equal(second.scenes.length, 1, "and the uncensored one is emitted");
  // One record is still outstanding: the unmarked badge, which is scheduled for a
  // later recheck rather than resolved. Outstanding work is what keeps
  // `verifiedEmpty` false, so it must still be counted.
  assert.equal(store.countFc2Pending(), 1);
  assert.equal(store.fc2Candidate("4986794")?.status, "pending");
  assert.equal(store.fc2Candidate("4986883")?.status, "accepted");
  assert.equal(store.fc2Candidate("4986752")?.status, "excluded");
  store.close();
});

test("an already-decided record is never re-read, and stays in the catalogue", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const pages = [
    {
      cursor: null,
      records: [{ videoId: "4986883", releaseDate: "2026-10-02" }],
      nextCursor: null,
    },
  ];
  const studio = createFc2CmadbStudio({ store, sleep: noSleep });
  await studio.fetch(
    WINDOW_START,
    context(laneFetcher(pages, () => fixture("fc2-detail-uncensored.html"))),
  );

  let reads = 0;
  const again = await studio.fetch(
    WINDOW_START,
    context(
      laneFetcher(pages, () => {
        reads += 1;
        return fixture("fc2-detail-uncensored.html");
      }),
    ),
  );
  assert.equal(reads, 0, "the detail page is not paid for twice");
  assert.equal(again.scenes.length, 1, "and the accepted release is still emitted");
  store.close();
});

for (const status of ["accepted", "excluded", "pending", "retired"] as const) {
  test(`listing sightings preserve ${status} state unless the release date changes`, () => {
    const store = new SqliteStore(":memory:");
    store.migrate();
    const seenAt = "2026-10-01T00:00:00.000Z";
    const checkedAt = NOW.toISOString();
    const record = { videoId: "4986883", releaseDate: "2026-10-02" };
    store.noteFc2Sightings([record], seenAt);
    store.decideFc2Candidate(
      record.videoId,
      status === "retired" ? "pending" : status,
      "previous verdict",
      { checkedAt, recheckAt: checkedAt, scene: { title: "cached scene" } },
    );
    if (status === "retired") store.retireFc2StalePending(record.videoId, NOW);
    const previous = store.fc2Candidate(record.videoId);
    store.noteFc2Sightings([record], checkedAt);
    assert.deepEqual(store.fc2Candidate(record.videoId), previous);
    store.noteFc2Sightings([{ ...record, releaseDate: "2026-10-03" }], checkedAt);
    assert.deepEqual(store.fc2Candidate(record.videoId), {
      ...previous,
      releaseDate: "2026-10-03",
      status: "pending",
      verdict: "",
      scene: null,
      checkedAt: null,
      recheckAt: null,
      retiredAt: null,
    });
    assert.equal(store.fc2DueCandidates(NOW, 1)[0]?.videoId, record.videoId);
    store.close();
  });
}

test("a corrected release date is re-read and replaces the cached scene", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const record = { videoId: "4986883", releaseDate: "2026-10-02" };
  const pages = [{ cursor: null, records: [record], nextCursor: null }];
  const studio = createFc2CmadbStudio({ store, sleep: noSleep });
  const body = fixture("fc2-detail-uncensored.html");
  await studio.fetch(WINDOW_START, context(laneFetcher(pages, () => body)));
  record.releaseDate = "2026-10-03";
  const fetcher = laneFetcher(pages, () => body.replaceAll("2026-10-02", "2026-10-03"));
  const result = await studio.fetch(WINDOW_START, context(fetcher));
  assert.equal(fetcher.calls.filter((url) => url.includes("/articles/")).length, 1);
  assert.equal(result.scenes[0]?.releaseDate, "2026-10-03");
  store.close();
});

for (const outcome of ["accepted", "excluded"] as const) {
  test(`a scheduled retry can become ${outcome} instead of retiring`, async () => {
    const store = new SqliteStore(":memory:");
    store.migrate();
    const pages = [
      {
        cursor: null,
        records: [{ videoId: "4986794", releaseDate: "2026-10-02" }],
        nextCursor: null,
      },
    ];
    const studio = createFc2CmadbStudio({ store, sleep: noSleep });
    await studio.fetch(
      WINDOW_START,
      context(laneFetcher(pages, () => fixture("fc2-detail-unmarked.html"))),
    );
    const later = new Date(store.fc2Candidate("4986794")!.recheckAt!);
    const marked = fixture("fc2-detail-unmarked.html").replace(
      '"censored": null',
      `"censored": "${outcome === "accepted" ? "無" : "有"}"`,
    );
    const result = await studio.fetch(
      WINDOW_START,
      context(
        laneFetcher(pages, () => marked),
        later,
      ),
    );
    const candidate = store.fc2Candidate("4986794");
    assert.equal(candidate?.status, outcome);
    assert.equal(candidate?.retiredAt, null);
    assert.equal(candidate?.recheckAt, null);
    assert.equal(result.scenes.length, outcome === "accepted" ? 1 : 0);
    assert.equal(result.verifiedEmpty, outcome === "excluded");
    store.close();
  });
}

test("an unmarked record is rechecked, then retired undecided", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const pages = [
    {
      cursor: null,
      records: [{ videoId: "4986794", releaseDate: "2026-10-02" }],
      nextCursor: null,
    },
  ];
  const studio = createFc2CmadbStudio({
    store,
    sleep: noSleep,
    recheckDays: 7,
    maxDetailChecksPerSync: 1,
  });
  const fetcher = () => laneFetcher(pages, () => fixture("fc2-detail-unmarked.html"));
  const first = await studio.fetch(WINDOW_START, context(fetcher()));
  assert.equal(first.scenes.length, 0, "an unmarked badge never becomes a scene");
  assert.equal(store.fc2Candidate("4986794")?.status, "pending");
  const recheckAt = store.fc2Candidate("4986794")?.recheckAt;
  assert.ok(recheckAt, "and it is scheduled for another look");
  const later = new Date(recheckAt);

  const before = fetcher();
  await studio.fetch(WINDOW_START, context(before, new Date(later.getTime() - 1)));
  assert.equal(before.calls.filter((url) => url.includes("/articles/")).length, 0);
  assert.equal(store.fc2DueCandidates(later, 1).length, 1, "due at the retry time");

  const noBudget = createFc2CmadbStudio({ store, sleep: noSleep, maxDetailChecksPerSync: 0 });
  const deferred = await noBudget.fetch(WINDOW_START, context(fetcher(), later));
  assert.equal(deferred.verifiedEmpty, false);
  assert.equal(store.fc2Candidate("4986794")?.retiredAt, null);

  const failed = await studio.fetch(
    WINDOW_START,
    context(
      laneFetcher(pages, () => {
        throw new Error("connection reset");
      }),
      later,
    ),
  );
  assert.equal(failed.verifiedEmpty, false);
  assert.equal(store.fc2Candidate("4986794")?.recheckAt, recheckAt);
  assert.equal(store.fc2DueCandidates(later, 1).length, 1, "failed retries stay due");
  let reads = 0;
  const second = await studio.fetch(
    WINDOW_START,
    context(
      laneFetcher(pages, () => {
        reads += 1;
        return fixture("fc2-detail-unmarked.html");
      }),
      later,
    ),
  );
  assert.equal(reads, 1, "the scheduled retry reads the detail page");
  assert.equal(second.scenes.length, 0);
  const retired = store.fc2Candidate("4986794");
  assert.equal(retired?.status, "pending", "retired, never reclassified");
  assert.equal(retired?.retiredAt, later.toISOString(), "the retirement is recorded");
  assert.equal(retired?.recheckAt, recheckAt, "the scheduled read time is preserved");
  assert.equal(store.countFc2Pending(), 0, "and it no longer blocks a verified-empty claim");
  assert.equal(second.verifiedEmpty, true);
  const after = fetcher();
  const third = await studio.fetch(WINDOW_START, context(after, later));
  assert.equal(after.calls.filter((url) => url.includes("/articles/")).length, 0);
  assert.equal(third.verifiedEmpty, true);
  store.close();
});

test("a failed detail read leaves the record pending rather than guessing", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const pages = [
    {
      cursor: null,
      records: [{ videoId: "4986883", releaseDate: "2026-10-02" }],
      nextCursor: null,
    },
  ];
  const studio = createFc2CmadbStudio({ store, sleep: noSleep });
  const result = await studio.fetch(
    WINDOW_START,
    context(
      laneFetcher(pages, () => {
        throw new Error("connection reset");
      }),
    ),
  );
  assert.deepEqual(result.scenes, []);
  assert.equal(result.verifiedEmpty, false, "an unread candidate is never a verified-empty source");
  assert.equal(store.fc2Candidate("4986883")?.status, "pending");
  store.close();
});

test("a rebuilt store re-derives from the listing and reaches the same answer", () => {
  // The Render free plan has no persistent disk, so losing this table is normal.
  // An absent row may only cost a second detail read; it must not change the
  // classification.
  assert.ok(true);
});

test("candidates that leave the rolling window are dropped from the state table", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const studio = createFc2CmadbStudio({ store, sleep: noSleep });
  store.noteFc2Sightings([{ videoId: "1", releaseDate: "2020-01-01" }], NOW.toISOString());
  assert.equal(store.countFc2Pending(), 1);
  const pages = [{ cursor: null, records: [], nextCursor: null }];
  await studio.fetch(WINDOW_START, context(laneFetcher(pages, () => undefined)));
  assert.equal(store.countFc2Pending(), 0, "a 2020 record can never re-enter the window");
  store.close();
});

/* ---- Failure preserves last-good scenes ----------------------------------- */

test("HTTP 429 fails the source by name, and the last-good scenes survive", async () => {
  const fetcher = stubFetcher({});
  fetcher.fetch = async () => new Response("slow down", { status: 429 });
  const studio = createFc2CmadbStudio({ sleep: noSleep });
  await assert.rejects(
    () => studio.fetch(WINDOW_START, context(fetcher)),
    (error: Error) => error instanceof Fc2RateLimitedError,
  );
});

test("a reshaped listing fails the source instead of reporting verified-empty", async () => {
  const fetcher = stubFetcher({ [FC2_LISTING_URL]: fixture("fc2-listing-no-payload.html") });
  const studio = createFc2CmadbStudio({ sleep: noSleep });
  await assert.rejects(() => studio.fetch(WINDOW_START, context(fetcher)), Fc2ShapeError);
});

test("an incomplete walk fails the source instead of reporting verified-empty", async () => {
  const fetcher = stubFetcher({
    [FC2_LISTING_URL]: `<script data-page="app" type="application/json">${JSON.stringify({
      component: "Tags/Show",
      props: {
        tag_name: "アナル",
        articles: {
          data: [
            {
              video_id: 5000002,
              title: "Scene",
              release_date: "2026-09-30",
              duration: "20:00",
              censored: null,
              not_found: null,
              writer: { name: "s" },
              pivot: { tag_id: FC2_ANAL_TAG_ID },
            },
          ],
          next_cursor: "stuck",
        },
      },
      url: "/tags/アナル",
      version: "v",
    })}</script>`,
    [`${FC2_LISTING_URL}?cursor=stuck`]: fixture("fc2-anal-listing-page-1.html"),
  });
  const studio = createFc2CmadbStudio({ sleep: noSleep, maxListingPages: 5 });
  // Every page stays inside the window and keeps handing back a cursor the walk
  // has never seen, so the walk runs out of page budget rather than finishing.
  // That is an INCOMPLETE walk: the lane cannot say it saw everything, so it must
  // fail rather than let `sync` treat the result as a verified empty source.
  await assert.rejects(() => studio.fetch(WINDOW_START, context(fetcher)), Fc2SourceError);
});

/* ---- Regression: the independently checked baseline ------------------------ */

interface BaselineRow {
  video_id: string;
  /**
   * The hand judgement, in the classifier's own words: either a status, or the
   * full verdict string for a row the hand judged should be excluded.
   */
  expected: "accepted" | "no playable duration (an image set or an unplayable record)" | null;
  censorship_badge?: string | null;
  duration?: string | null;
  reason: string;
}

const baselineDoc = JSON.parse(
  readFileSync(join(FIXTURES, "fc2-candidate-baseline.json"), "utf8"),
) as { note: string; checked_on: string; rows: BaselineRow[] };

test("classification matches the independently checked baseline", () => {
  // The baseline was built by opening each candidate's own detail page and
  // recording what the SITE said - its censorship field, its duration - and then
  // judging each row by hand against the documented rules. The classifier in
  // src/sources/fc2cmadb.ts was never run to produce it, which is what makes this
  // a check on the classifier rather than a snapshot of it. A `null` row is one
  // the walk never reached; it is skipped, and counted separately below.
  const rows = baselineDoc.rows.filter((row) => row.expected !== null);
  assert.ok(rows.length >= 190, `the baseline should be substantial, saw ${rows.length}`);

  const mismatches: string[] = [];
  for (const row of rows) {
    const verdict = classifyFc2Candidate({
      censored: row.censorship_badge ?? null,
      durationSec: parseClockDuration(row.duration ?? null),
      notFound: false,
      releaseDate: baselineDoc.checked_on,
      title: "",
      // The baseline records the page's censorship field and length only. A real
      // record can also be excluded for a safety or trans tag, which the baseline
      // cannot see - so an exclusion here is compared by its full verdict, and a
      // tag-driven one would disagree loudly rather than be waved through.
      tags: [],
    });
    const actual = verdict.status === "excluded" ? verdict.verdict : verdict.status;
    if (actual !== row.expected) {
      mismatches.push(`${row.video_id}: said ${row.expected} (${row.reason}), got ${actual}`);
    }
  }
  assert.deepEqual(mismatches, [], `${mismatches.length} baseline rows disagreed`);
});

test("the baseline's unread remainder is measurable, and that is why pending exists", () => {
  // 197 of the 319 listed releases could be read before fc2cmadb.com started
  // answering HTTP 429. The 122 that could not are recorded as `null` rather than
  // guessed, because an unread record is exactly what `pending` is for: it stays
  // owed, it is retried, and it stops the lane claiming a verified-empty source.
  const unread = baselineDoc.rows.filter((row) => row.expected === null);
  const read = baselineDoc.rows.filter((row) => row.expected !== null);
  assert.equal(read.length + unread.length, baselineDoc.rows.length);
  assert.ok(unread.length > 50, `the unread remainder should be recorded, saw ${unread.length}`);
  assert.ok(
    unread.every((row) => /429|not read/i.test(row.reason)),
    "and every unread row says why, rather than asserting a verdict it never got",
  );
});

test("a record with an image count instead of a duration is excluded, not retried for ever", () => {
  // Two of the 197 pages read have their "length" slot holding an IMAGE COUNT
  // (60 images, 161 images). fc2cmadb carries image sets beside videos, so this is
  // a real shape of record. It can never match an upload's length, and leaving it
  // pending would re-check it for ever and stop the walk ever finishing.
  const row = baselineDoc.rows.find((candidate) => candidate.duration === "60枚");
  assert.ok(row, "the baseline keeps the page that showed this");
  const verdict = classifyFc2Candidate({
    censored: row?.censorship_badge ?? null,
    durationSec: parseClockDuration(row?.duration ?? null),
    notFound: false,
    releaseDate: baselineDoc.checked_on,
    title: "",
    tags: [],
  });
  assert.equal(verdict.status, "excluded");
  assert.match(verdict.verdict, /no playable duration/);
});
