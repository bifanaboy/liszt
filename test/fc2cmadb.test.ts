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
import { parseClockDuration } from "../src/tubes/eporner.ts";
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

test("a title that literally contains &quot; is not unescaped into a stray quote", () => {
  // The payload is raw script text, so `&quot;` in a title is five literal
  // characters and the title is the field the classifier reads. Unescaping first
  // would rewrite it; unescaping only after a failed parse cannot.
  const html = fixture("fc2-detail-uncensored.html").replace(
    '"title": "【托卵実録】',
    '"title": "A &quot;quoted&quot; word &amp; more 【托卵実録】',
  );
  const detail = parseFc2Detail(extractInertiaPage(html));
  assert.match(detail.title, /A &quot;quoted&quot; word &amp; more/);
  assert.equal(
    parseFc2Detail(extractInertiaPage(fixture("fc2-detail-uncensored.html"))).title,
    detail.title.replace(/A &quot;quoted&quot; word &amp; more /, ""),
    "the rest of the title is untouched",
  );
});

test("a page with no payload is a shape failure, not an empty listing", () => {
  // THE distinction that matters: an empty tag and a page that is not a page look
  // identical to any reader that returns `[]` on failure, and the empty reading
  // would let the lane claim a verified emptiness it never verified.
  assert.throws(
    () => extractInertiaPage(fixture("fc2-listing-no-payload.html")),
    (error: Error) =>
      error instanceof Fc2ShapeError && /no Inertia page payload/.test(error.message),
  );
});

test("truncated page JSON fails loudly instead of parsing to something plausible", () => {
  // A truncated response is a page that IS there with a payload that is not, so
  // this must fail at `JSON.parse` rather than at the payload lookup - the two
  // failures need different fixes and are told apart by their message.
  assert.throws(
    () => extractInertiaPage(fixture("fc2-listing-truncated-json.html")),
    (error: Error) => error instanceof Fc2ShapeError && /not valid JSON/.test(error.message),
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
  assert.equal(
    walk.edgeStop,
    false,
    "the last page was the end of the tag, so nothing was skipped",
  );
});

test("a window-edge stop with a cursor left reports that pages went unread", async () => {
  // The same stop, but the site still offered a next page. Everything below the
  // stop is unknown, so the walk must not be usable as proof of emptiness.
  const fetcher = listingFetcher([
    {
      cursor: null,
      records: [{ videoId: "5000002", releaseDate: "2026-09-30" }],
      nextCursor: "c1",
    },
    {
      cursor: "c1",
      records: [{ videoId: "5000001", releaseDate: "2019-01-01" }],
      nextCursor: "c2",
    },
  ]);
  const walk = await walkFc2Listing(
    {
      listAnalTag: async (cursor) =>
        parseFc2Listing(
          extractInertiaPage(
            await fetcher.text(cursor === null ? FC2_LISTING_URL : `${FC2_LISTING_URL}?cursor=c1`),
          ),
        ),
      getArticle: async () => {
        throw new Error("not used");
      },
    },
    WINDOW_START,
  );
  assert.equal(walk.pages, 2);
  assert.ok(walk.reachedEnd, "it stopped cleanly rather than failing");
  assert.equal(walk.edgeStop, true, "a page the walk never read was left below the stop");
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

for (const { name, videoIds, budget, pending } of [
  { name: "pending decisions", videoIds: ["4986794"], budget: 1, pending: 1 },
  { name: "zero detail budget", videoIds: ["4986794"], budget: 0, pending: 1 },
  { name: "exhausted detail budget", videoIds: ["4986752", "4986794"], budget: 1, pending: 1 },
  { name: "all records excluded", videoIds: ["4986752"], budget: 1, pending: 0 },
  {
    name: "pending, failed and unchecked records",
    videoIds: ["4986752", "4986794", "4986883", "4986048"],
    budget: 3,
    pending: 3,
  },
]) {
  test(`storeless accounting: ${name}`, async () => {
    const fetcher = laneFetcher(
      [
        {
          cursor: null,
          records: [
            ...videoIds.map((videoId) => ({ videoId, releaseDate: "2026-10-02" })),
            { videoId: "4000000", releaseDate: "2026-07-04" },
            { videoId: "6000000", releaseDate: "2026-10-04" },
          ],
          nextCursor: null,
        },
      ],
      (id) =>
        ({
          "4986752": fixture("fc2-detail-censored.html"),
          "4986794": fixture("fc2-detail-unmarked.html"),
        })[id],
    );
    const studio = createFc2CmadbStudio({ sleep: noSleep, maxDetailChecksPerSync: budget });
    let reportedPending: unknown;
    if (name.includes("failed")) {
      await assert.rejects(() => studio.fetch(WINDOW_START, context(fetcher)), /no fixture/);
      return;
    }
    const result = await studio.fetch(WINDOW_START, {
      ...context(fetcher),
      log: (message, fields) => {
        if (message === "fc2: walk finished") reportedPending = fields?.pending;
      },
    });
    assert.deepEqual(result.scenes, []);
    assert.equal(result.verifiedEmpty, pending === 0);
    assert.equal(reportedPending, pending, "each unresolved in-window record is counted once");
    assert.equal(fetcher.calls.filter((url) => url.includes("/articles/")).length, budget);
  });
}

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

  await assert.rejects(
    () =>
      studio.fetch(
        WINDOW_START,
        context(
          laneFetcher(pages, () => {
            throw new Error("connection reset");
          }),
          later,
        ),
      ),
    /connection reset/,
  );
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
  await assert.rejects(
    () =>
      studio.fetch(
        WINDOW_START,
        context(
          laneFetcher(pages, () => {
            throw new Error("connection reset");
          }),
        ),
      ),
    /connection reset/,
  );
  assert.equal(store.fc2Candidate("4986883")?.status, "pending");
  store.close();
});

test("one unreadable record cannot starve the rest of the queue", async () => {
  // The due order is oldest-first, so a record the site will never serve sits at
  // the head of every queue. If its failure ended the run, nothing behind it
  // would ever be read - the lane would spend each sync on the same request and
  // never classify a single release.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    const pages = [
      {
        cursor: null,
        records: [
          { videoId: "4986794", releaseDate: "2026-10-02" },
          { videoId: "4986883", releaseDate: "2026-10-02" },
        ],
        nextCursor: null,
      },
    ];
    const studio = createFc2CmadbStudio({ store, sleep: noSleep });
    await assert.rejects(
      () =>
        studio.fetch(
          WINDOW_START,
          context(
            laneFetcher(pages, (id) => {
              if (id === "4986794") throw new Error("connection reset");
              return fixture("fc2-detail-uncensored.html");
            }),
          ),
        ),
      /connection reset/,
    );
    assert.equal(
      store.fc2Candidate("4986794")?.status,
      "pending",
      "the unreadable record stays undecided, never guessed",
    );
    assert.equal(
      store.fc2Candidate("4986883")?.status,
      "accepted",
      "the record behind it was still read and remembered",
    );
    assert.equal(
      store.fc2Candidate("4986794")?.recheckAt,
      null,
      "the unreadable one stays due rather than being given a retry date",
    );
  } finally {
    store.close();
  }
});

test("a rebuilt store re-derives the same scene with bounded detail work", async () => {
  const stores = [new SqliteStore(":memory:"), new SqliteStore(":memory:")];
  const pages = [
    {
      cursor: null,
      records: [{ videoId: "4986883", releaseDate: "2026-10-02" }],
      nextCursor: null,
    },
  ];
  try {
    const results = [];
    for (const store of stores) {
      store.migrate();
      const studio = createFc2CmadbStudio({ store, sleep: noSleep, maxDetailChecksPerSync: 1 });
      const first = laneFetcher(pages, () => fixture("fc2-detail-uncensored.html"));
      results.push(await studio.fetch(WINDOW_START, context(first)));
      assert.equal(first.calls.filter((url) => url.includes("/articles/")).length, 1);
      const cached = laneFetcher(pages, () => {
        throw new Error("cached scene fetched again");
      });
      assert.deepEqual(await studio.fetch(WINDOW_START, context(cached)), results.at(-1));
      assert.equal(cached.calls.filter((url) => url.includes("/articles/")).length, 0);
    }
    assert.deepEqual(results[0], results[1]);
  } finally {
    for (const store of stores) store.close();
  }
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

/* ---- Record shapes the site really carries -------------------------------- */

test("a record with an image count instead of a duration is excluded, not retried for ever", () => {
  // fc2cmadb carries IMAGE SETS beside videos, and an image set's "length" slot
  // holds a count ("60枚", "161枚") rather than a clock. `parseClockDuration`
  // returns null for it, so such a record can never match an upload's length -
  // and leaving it pending would re-check it for ever and stop the walk ever
  // being able to claim it saw everything, which is the opposite of what pending
  // is for. Unreadable PAGES stay pending; a page that was read and says this
  // stays excluded.
  assert.equal(parseClockDuration("60枚"), null);
  assert.equal(parseClockDuration("161枚"), null);
  const verdict = classifyFc2Candidate({
    censored: "無",
    durationSec: parseClockDuration("60枚"),
    notFound: false,
    releaseDate: "2026-09-30",
    title: "",
    tags: [],
  });
  assert.equal(verdict.status, "excluded");
  assert.match(verdict.verdict, /no playable duration/);
});

test("malformed listing records cannot make a walk appear empty", () => {
  const page = extractInertiaPage(fixture("fc2-anal-listing-page-1.html"));
  (page.props.articles as { data: unknown[] }).data = [{ video_id: null, title: "record" }];
  assert.throws(() => parseFc2Listing(page), Fc2ShapeError);
});

test("missing full detail tags cannot silently bypass exclusions", () => {
  const page = extractInertiaPage(fixture("fc2-detail-uncensored.html"));
  delete (page.props.article as Record<string, unknown>).tags;
  assert.throws(() => parseFc2Detail(page), Fc2ShapeError);
});

test("empty and whitespace-only FC2 tag names are ignored while malformed entries still fail", () => {
  const page = extractInertiaPage(fixture("fc2-detail-uncensored.html"));
  const article = page.props.article as Record<string, unknown>;
  const tags = article.tags as Array<Record<string, unknown>>;
  article.tags = [...tags, { name: "" }, { name: "  " }];
  assert.deepEqual(
    parseFc2Detail(page).tags,
    parseFc2Detail(extractInertiaPage(fixture("fc2-detail-uncensored.html"))).tags,
  );
  article.tags = [...tags, { name: 42 }];
  assert.throws(() => parseFc2Detail(page), Fc2ShapeError);
});

test("foreign-tag listing rows never enter candidate state or detail work", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  const page = extractInertiaPage(fixture("fc2-anal-listing-foreign-tag.html"));
  (page.props.articles as Record<string, unknown>).next_cursor = null;
  const fetcher = stubFetcher({
    [FC2_LISTING_URL]: `<script data-page="app" type="application/json">${JSON.stringify(page)}</script>`,
  });
  try {
    const studio = createFc2CmadbStudio({ store, sleep: noSleep });
    const result = await studio.fetch(WINDOW_START, context(fetcher));
    assert.deepEqual(result.scenes, []);
    assert.equal(store.countFc2Pending(), 0);
    assert.equal(fetcher.calls.filter((url) => url.includes("/articles/")).length, 0);
  } finally {
    store.close();
  }
});

for (const changed of ["removed", "censored"] as const) {
  test(`a listing marked ${changed} stops emitting a previously accepted cached scene`, async () => {
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
    try {
      const first = await studio.fetch(
        WINDOW_START,
        context(laneFetcher(pages, () => fixture("fc2-detail-uncensored.html"))),
      );
      assert.equal(first.scenes.length, 1);
      const base = laneFetcher(pages, () => fixture("fc2-detail-uncensored.html"));
      const changedFetcher: Fetcher = {
        ...base,
        async fetch(url) {
          const response = await base.fetch(url);
          if (url.includes("/tags/")) {
            const page = extractInertiaPage(await response.text());
            const record = (page.props.articles as { data: Record<string, unknown>[] }).data[0]!;
            if (changed === "removed") record.not_found = 1;
            else record.censored = "有";
            return new Response(
              `<script data-page="app" type="application/json">${JSON.stringify(page)}</script>`,
            );
          }
          return response;
        },
      };
      const second = await studio.fetch(WINDOW_START, context(changedFetcher));
      assert.deepEqual(second.scenes, []);
      assert.equal(store.fc2Candidate("4986883")?.status, "excluded");
    } finally {
      store.close();
    }
  });
}

test("a walk that stopped early cannot claim the tag is empty", async () => {
  // The reading that matters: nothing in the window, no work owed, and still no
  // claim. A page the walk never read could hold a backdated record, and a claim
  // here would tell the sync the tag was verified empty when it was not checked.
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    const fetcher = laneFetcher(
      [
        {
          cursor: null,
          records: [{ videoId: "4986883", releaseDate: "2019-01-01" }],
          nextCursor: "c1",
        },
        {
          cursor: "c1",
          records: [{ videoId: "4986700", releaseDate: "2018-01-01" }],
          nextCursor: "c2",
        },
      ],
      () => undefined,
    );
    const result = await createFc2CmadbStudio({ store, sleep: noSleep }).fetch(
      WINDOW_START,
      context(fetcher),
    );
    assert.deepEqual(result.scenes, []);
    assert.equal(store.countFc2Pending(), 0, "nothing was left undecided either");
    assert.equal(result.verifiedEmpty, false, "an unread page is not a verified emptiness");
  } finally {
    store.close();
  }
});

test("the boundary page's historical records consume no detail budget or state", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    const fetcher = laneFetcher(
      [
        {
          cursor: null,
          records: [{ videoId: "1234567", releaseDate: "2020-01-01" }],
          nextCursor: null,
        },
      ],
      () => undefined,
    );
    const studio = createFc2CmadbStudio({ store, sleep: noSleep });
    const result = await studio.fetch(WINDOW_START, context(fetcher));
    assert.equal(result.verifiedEmpty, true);
    assert.equal(store.fc2Candidate("1234567"), null);
    assert.equal(fetcher.calls.filter((url) => url.includes("/articles/")).length, 0);
  } finally {
    store.close();
  }
});

for (const status of [404, 410]) {
  test(`a detail page removed with HTTP ${status} is excluded instead of retried forever`, async () => {
    const store = new SqliteStore(":memory:");
    store.migrate();
    try {
      const base = laneFetcher(
        [
          {
            cursor: null,
            records: [{ videoId: "4986883", releaseDate: "2026-10-02" }],
            nextCursor: null,
          },
        ],
        () => fixture("fc2-detail-uncensored.html"),
      );
      const fetcher: Fetcher = {
        ...base,
        async fetch(url) {
          return url.includes("/articles/") ? new Response("gone", { status }) : base.fetch(url);
        },
      };
      const result = await createFc2CmadbStudio({ store, sleep: noSleep }).fetch(
        WINDOW_START,
        context(fetcher),
      );
      assert.deepEqual(result.scenes, []);
      assert.equal(result.verifiedEmpty, true);
      assert.equal(store.fc2Candidate("4986883")?.status, "excluded");
      assert.deepEqual(result.excludedSceneIds, ["4986883"]);
    } finally {
      store.close();
    }
  });
}

test("detail dates outside the window cannot be emitted fresh or from cache", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  try {
    const studio = createFc2CmadbStudio({ store, sleep: noSleep });
    const pages = [
      {
        cursor: null,
        records: [{ videoId: "4986883", releaseDate: "2026-10-02" }],
        nextCursor: null,
      },
    ];
    const detail = fixture("fc2-detail-uncensored.html").replace(
      '"release_date": "2026-10-02"',
      '"release_date": "2020-01-01"',
    );
    for (let cycle = 0; cycle < 2; cycle++) {
      const result = await studio.fetch(WINDOW_START, context(laneFetcher(pages, () => detail)));
      assert.deepEqual(result.scenes, []);
      assert.equal(result.verifiedEmpty, true);
    }
  } finally {
    store.close();
  }
});

test("FC2 classification matches 60 independently checked detail pages", () => {
  const baseline = JSON.parse(fixture("fc2-classification-baseline.json")) as {
    records: {
      videoId: string;
      detailUrl: string;
      title: string;
      releaseDate: string;
      duration: string | null;
      censored: string | null;
      notFound: boolean;
      tags: string[];
      expected: {
        class: "qualifying" | "censored" | "excluded" | "ambiguous";
        status: "accepted" | "excluded" | "pending";
        reason: string;
      };
    }[];
  };
  const classes = new Set<string>();

  assert.equal(baseline.records.length, 60);
  assert.equal(new Set(baseline.records.map((record) => record.videoId)).size, 60);
  for (const record of baseline.records) {
    assert.match(record.detailUrl, new RegExp(`/articles/${record.videoId}$`));
    const result = classifyFc2Candidate({
      title: record.title,
      releaseDate: record.releaseDate,
      durationSec: parseClockDuration(record.duration),
      censored: record.censored,
      notFound: record.notFound,
      tags: record.tags,
    });
    classes.add(record.expected.class);
    assert.equal(result.status, record.expected.status, record.videoId);
    assert.equal(result.verdict, record.expected.reason, record.videoId);
  }

  assert.deepEqual([...classes].sort(), ["ambiguous", "censored", "excluded", "qualifying"]);
});
