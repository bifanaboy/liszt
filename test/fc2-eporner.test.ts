/**
 * The FC2 eporner lane: exact-code admission, the bounded related walk, and the
 * multipart rule that decides when uploads may be called parts.
 *
 * THE FIXTURES ARE SYNTHETIC, and that is stated in each one. eporner's edge
 * answered this workspace with an HTTP 200 JavaScript challenge rather than JSON
 * or HTML, so no live body was obtainable and nothing here is calibrated against
 * one. The parsers are written to the URL grammar `tubes/eporner-pool.ts` already
 * depends on, and every test below is about a RULE rather than about eporner's
 * current markup: what may be admitted, what may be followed, and what may be
 * called a part.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createFc2EpornerResolver,
  epornerDurationFromPage,
  epornerUploaderFromPage,
  fc2EpornerSearchUrl,
  fc2ReleaseCode,
  groupMultipart,
  parseFc2EpornerSearch,
  relatedFc2VideoIds,
  titleContainsExactCode,
  titleFromPage,
  type Fc2EpornerCandidate,
  type Fc2Link,
  type Fc2LookupResult,
} from "../src/tubes/fc2-eporner.ts";
import { emptyRejections, resolveFc2Scene, resolveLinks } from "../src/tubes/resolve.ts";
import { makeScene } from "./helpers.ts";
import type { Fetcher } from "../src/sources/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const NOW = new Date("2026-10-03T00:00:00Z");
const noSleep = async (): Promise<void> => {};
/** A lane answer: the links plus the counters the lane reports alongside them. */
const lookupResult = (links: Fc2Link[], error?: string): Fc2LookupResult => ({
  links,
  code: "4979341",
  pagesRead: 1,
  candidatePagesRead: 1,
  relatedFollowed: 0,
  ...(error === undefined ? {} : { error }),
});

/* ---- The release code ----------------------------------------------------- */

test("the release code is read from the record URL, the label form, or a bare id", () => {
  assert.equal(fc2ReleaseCode("https://fc2cmadb.com/articles/4979341"), "4979341");
  assert.equal(fc2ReleaseCode("FC2-PPV-4979341"), "4979341");
  assert.equal(fc2ReleaseCode("4979341"), "4979341");
});

test("an arbitrary URL is not mined for digits", () => {
  // `?id=14979341` is a DIFFERENT release. A permissive reader would resolve this
  // scene to somebody else's upload.
  assert.equal(fc2ReleaseCode("https://example.test/watch?id=14979341"), null);
  assert.equal(fc2ReleaseCode(""), null);
  assert.equal(fc2ReleaseCode(null), null);
});

/* ---- Token-bounded admission ----------------------------------------------- */

test("the code must be a whole numeric token", () => {
  assert.ok(titleContainsExactCode("FC2-PPV-4979341 [Part 1]", "4979341"));
  assert.ok(titleContainsExactCode("[4979341]", "4979341"));
  assert.ok(titleContainsExactCode("part 4979341", "4979341"));
  assert.equal(
    titleContainsExactCode("14979341", "4979341"),
    false,
    "a longer number is not a hit",
  );
  assert.equal(
    titleContainsExactCode("49793410", "4979341"),
    false,
    "nor is one that starts with it",
  );
  assert.equal(titleContainsExactCode("no code here", "4979341"), false);
});

test("a non-numeric code can never match", () => {
  assert.equal(titleContainsExactCode("FC2-PPV-4979341", "PPV"), false);
});

/* ---- Query construction --------------------------------------------------- */

test("the query carries the bare numeric id and nothing else", () => {
  const url = new URL(fc2EpornerSearchUrl("4979341", 2, 20));
  assert.equal(url.searchParams.get("query"), "4979341");
  assert.equal(url.searchParams.get("page"), "2");
  assert.equal(url.searchParams.get("per_page"), "20");
  assert.equal(url.searchParams.get("lq"), "0", "low-quality uploads must not be included");
  // The forbidden spellings, asserted by their absence.
  for (const forbidden of ["FC2", "PPV", "fc2cmadb"]) {
    assert.ok(!url.href.includes(forbidden), `the query must not carry "${forbidden}"`);
  }
});

/* ---- Search admission ----------------------------------------------------- */

test("only exact-token rows are admitted, and the lookalikes are dropped", () => {
  const body = JSON.parse(fixture("eporner-fc2-search-4979341.json")) as unknown;
  const rows = parseFc2EpornerSearch(body, "4979341");
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    ["a1b2c3", "d4e5f6", "z9y8x7"],
    "the three exact-code rows, and not 14979341, 49793410 or the untitled one",
  );
});

test("a bare array body parses as well as a paginator", () => {
  const rows = parseFc2EpornerSearch(
    [{ id: "abc", title: "FC2-PPV-4979341", url: "https://www.eporner.com/video-abc/" }],
    "4979341",
  );
  assert.equal(rows.length, 1);
});

test("a row with no usable URL is dropped rather than linked", () => {
  const rows = parseFc2EpornerSearch(
    [{ id: "abc", title: "FC2-PPV-4979341", url: "https://evil.test/video-abc/" }],
    "4979341",
  );
  assert.deepEqual(rows, []);
});

test("duplicate URLs across rows collapse to one candidate", () => {
  const rows = parseFc2EpornerSearch(
    [
      { id: "abc", title: "FC2-PPV-4979341", url: "https://www.eporner.com/video-abc/" },
      { id: "abc", title: "FC2-PPV-4979341 again", url: "https://www.eporner.com/video-abc/" },
    ],
    "4979341",
  );
  assert.equal(rows.length, 1);
});

/* ---- Page readers --------------------------------------------------------- */

test("the uploader is read from the page, and its absence is null rather than a guess", () => {
  assert.equal(epornerUploaderFromPage(fixture("eporner-fc2-video-a1b2c3.html")), "Fc2Ripper");
  assert.equal(epornerUploaderFromPage("<html><body>no profile link</body></html>"), null);
});

test("the page's own duration is read for the multipart decision", () => {
  assert.equal(epornerDurationFromPage(fixture("eporner-fc2-video-a1b2c3.html")), 1180);
  assert.equal(epornerDurationFromPage("<html></html>"), null);
});

test("the page title is what the related walk admits on", () => {
  assert.equal(
    titleFromPage(fixture("eporner-fc2-video-a1b2c3.html")),
    "FC2-PPV-4979341 [Part 1] 148cm idol first anal",
  );
  assert.equal(titleFromPage("<html></html>"), null);
});

/* ---- The related walk ------------------------------------------------------ */

test("only related links whose own slug carries the code are followed", () => {
  const body = fixture("eporner-fc2-video-a1b2c3.html");
  // The page re-offers itself, so the caller passes the seed as excluded. Every
  // other slug on the page is admitted only when that slug itself carries the
  // code - the `look`-prefixed one does not, and is dropped.
  const ids = relatedFc2VideoIds(body, "4979341", { exclude: new Set(["a1b2c3"]) });
  assert.deepEqual(ids, ["d4e5f6", "z9y8x7"], "the unrelated upload is not followed");
});

test("a page does not re-offer itself", () => {
  const ids = relatedFc2VideoIds(fixture("eporner-fc2-video-a1b2c3.html"), "4979341", {
    exclude: new Set(["a1b2c3"]),
  });
  assert.ok(!ids.includes("a1b2c3"));
});

test("a video id cannot consume the title-gated related budget", () => {
  const html =
    '<a href="/video-A4979341Z/unrelated/">Unrelated title</a><a href="/video-good/4979341-part-2/">4979341 part2</a>';
  assert.deepEqual(relatedFc2VideoIds(html, "4979341", { bound: 1 }), ["good"]);
});

test("the related walk is bounded", () => {
  const ids = relatedFc2VideoIds(fixture("eporner-fc2-video-a1b2c3.html"), "4979341", {
    exclude: new Set(["a1b2c3"]),
    bound: 1,
  });
  assert.equal(ids.length, 1);
});

/* ---- Multipart ------------------------------------------------------------- */

function candidate(
  id: string,
  durationSec: number | null,
  uploader: string | null,
): Fc2EpornerCandidate {
  return {
    id,
    url: `https://www.eporner.com/video-${id}/`,
    title: `FC2-PPV-4979341 Part ${{ a: 1, b: 2, c: 3 }[id] ?? 1}`,
    durationSec,
    uploader,
  };
}

test("one uploader with distinct durations earns part numbers", () => {
  const parts = groupMultipart([
    candidate("c", 1345, "Fc2Ripper"),
    candidate("a", 1180, "Fc2Ripper"),
    candidate("b", 1290, "Fc2Ripper"),
  ]);
  assert.equal(parts.size, 3);
  // Part numbers come from titles, independently of search order or duration.
  assert.equal(parts.get("https://www.eporner.com/video-a/"), 1);
  assert.equal(parts.get("https://www.eporner.com/video-b/"), 2);
  assert.equal(parts.get("https://www.eporner.com/video-c/"), 3);
});

test("DIFFERENT uploaders do not imply parts", () => {
  const parts = groupMultipart([
    candidate("a", 1180, "Fc2Ripper"),
    candidate("b", 1290, "SomeoneElse"),
  ]);
  assert.equal(parts.size, 0, "two accounts that share a code are two releases");
});

test("EQUAL durations do not imply parts", () => {
  const parts = groupMultipart([
    candidate("a", 1180, "Fc2Ripper"),
    candidate("b", 1180, "Fc2Ripper"),
  ]);
  assert.equal(parts.size, 0, "the same length twice is the same file twice");
});

test("an unknown uploader or an unread duration withholds the part numbers", () => {
  assert.equal(groupMultipart([candidate("a", 1180, null), candidate("b", 1290, null)]).size, 0);
  assert.equal(groupMultipart([candidate("a", 1180, "U"), candidate("b", null, "U")]).size, 0);
});

test("one upload is never a part of anything", () => {
  assert.equal(groupMultipart([candidate("a", 1180, "U")]).size, 0);
});

/* ---- The resolver, end to end --------------------------------------------- */

function resolverFetcher(routes: Record<string, string>, missing?: Set<string>): Fetcher {
  return {
    async fetch(url: string): Promise<Response> {
      const key = Object.keys(routes)
        .sort((a, b) => b.length - a.length)
        .find((candidateUrl) => url.startsWith(candidateUrl));
      const body = key === undefined ? undefined : routes[key];
      if (body === undefined || missing?.has(url)) {
        return new Response("missing", { status: 404 });
      }
      const type = url.includes("/api/") ? "application/json" : "text/html; charset=utf-8";
      return new Response(body, { status: 200, headers: { "content-type": type } });
    },
    async text(url: string): Promise<string> {
      return (await this.fetch(url)).text();
    },
    async json<T>(url: string): Promise<T> {
      return (await this.fetch(url)).json() as T;
    },
  };
}

const ROUTES = {
  "https://www.eporner.com/api/v2/video/search/": fixture("eporner-fc2-search-4979341.json"),
  "https://www.eporner.com/video-a1b2c3/": fixture("eporner-fc2-video-a1b2c3.html"),
  "https://www.eporner.com/video-d4e5f6/": fixture("eporner-fc2-video-d4e5f6.html"),
  "https://www.eporner.com/video-z9y8x7/": fixture("eporner-fc2-video-z9y8x7.html"),
};

test("every exact-code upload is returned, and the lookalikes never appear", async () => {
  const lookup = createFc2EpornerResolver(resolverFetcher(ROUTES), {
    sleep: noSleep,
    minIntervalMs: 0,
    relatedBound: 0,
  });
  const result = await lookup("4979341");
  assert.deepEqual(result.links.map((link) => link.url).sort(), [
    "https://www.eporner.com/video-a1b2c3/fc2-ppv-4979341-part-1/",
    "https://www.eporner.com/video-d4e5f6/fc2-ppv-4979341-part-2/",
    "https://www.eporner.com/video-z9y8x7/fc2-ppv-4979341-part-3/",
  ]);
  assert.ok(!result.links.some((link) => link.url.includes("look")), "no substring lookalike");
  // The fixture answers page 2 with page 1's rows. Reading it proves the page made
  // no progress, so the walk stops there instead of spending its whole budget on
  // a search that has already said everything it is going to say.
  assert.equal(result.pagesRead, 2);
});

test("no part numbers when the group is not verified", async () => {
  // The fixture set is two uploaders and two distinct durations, so the multipart
  // rule must withhold every part number - all-or-nothing, not two out of three.
  const lookup = createFc2EpornerResolver(resolverFetcher(ROUTES), {
    sleep: noSleep,
    minIntervalMs: 0,
    relatedBound: 0,
  });
  const result = await lookup("4979341");
  assert.ok(result.links.every((link) => link.part === undefined));
  assert.deepEqual(result.links.map((link) => link.uploader).sort(), [
    "Fc2Ripper",
    "Fc2Ripper",
    "SomeoneElse",
  ]);
});

test("part numbers ARE assigned for one uploader with distinct durations", async () => {
  const lookup = createFc2EpornerResolver(
    resolverFetcher({
      "https://www.eporner.com/api/v2/video/search/": JSON.stringify({
        videos: [
          {
            id: "a1b2c3",
            title: "FC2-PPV-4979341 part 1",
            url: "https://www.eporner.com/video-a1b2c3/x/",
            length_sec: 1180,
          },
          {
            id: "d4e5f6",
            title: "FC2-PPV-4979341 part 2",
            url: "https://www.eporner.com/video-d4e5f6/y/",
            length_sec: 1290,
          },
        ],
      }),
      "https://www.eporner.com/video-a1b2c3/": fixture("eporner-fc2-video-a1b2c3.html"),
      "https://www.eporner.com/video-d4e5f6/": fixture("eporner-fc2-video-d4e5f6.html"),
    }),
    { sleep: noSleep, minIntervalMs: 0, relatedBound: 0 },
  );
  const result = await lookup("4979341");
  assert.deepEqual(
    result.links.map((link) => link.part),
    [1, 2],
  );
});

test("a non-numeric input resolves nothing and asks nothing", async () => {
  let asked = 0;
  const lookup = createFc2EpornerResolver(
    {
      ...resolverFetcher({}),
      async fetch(): Promise<Response> {
        asked += 1;
        return new Response("nope", { status: 500 });
      },
      async text(url: string): Promise<string> {
        return (await this.fetch(url)).text();
      },
      async json<T>(url: string): Promise<T> {
        return (await this.fetch(url)).json() as T;
      },
    },
    { sleep: noSleep, minIntervalMs: 0 },
  );
  const result = await lookup("not a code");
  assert.deepEqual(result.links, []);
  assert.equal(result.code, null);
  assert.equal(asked, 0);
});

test("an anti-bot challenge is refused, and never read as an empty search", async () => {
  // eporner's edge answers HTTP 200 with a JavaScript body. Reading that as
  // "the search found nothing" would manufacture a verified-empty result, so the
  // content type is checked before the body speaks.
  const lookup = createFc2EpornerResolver(
    {
      async fetch(): Promise<Response> {
        return new Response("<script>window.location='https://example.test'</script>", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        });
      },
      async text(url: string): Promise<string> {
        return (await this.fetch(url)).text();
      },
      async json<T>(url: string): Promise<T> {
        return (await this.fetch(url)).json() as T;
      },
    },
    { sleep: noSleep, minIntervalMs: 0 },
  );
  const result = await lookup("4979341");
  assert.deepEqual(result.links, []);
  assert.equal(result.pagesRead, 0, "no search page was actually read");
  assert.match(result.error ?? "", /unusable body/);
});

test("an unreadable candidate page yields no verified link", async () => {
  const lookup = createFc2EpornerResolver(
    resolverFetcher(
      {
        "https://www.eporner.com/api/v2/video/search/": JSON.stringify({
          videos: [
            {
              id: "a1b2c3",
              title: "FC2-PPV-4979341",
              url: "https://www.eporner.com/video-a1b2c3/x/",
              length_sec: 1180,
            },
          ],
        }),
      },
      new Set(["https://www.eporner.com/video-a1b2c3/x/"]),
    ),
    { sleep: noSleep, minIntervalMs: 0, relatedBound: 0 },
  );
  const result = await lookup("4979341");
  assert.deepEqual(result.links, []);
  assert.match(result.error ?? "", /HTTP 404/);
});

test("the related walk is bounded and only admits on the code", async () => {
  const lookup = createFc2EpornerResolver(resolverFetcher(ROUTES), {
    sleep: noSleep,
    minIntervalMs: 0,
    relatedBound: 1,
  });
  const result = await lookup("4979341");
  assert.ok(result.relatedFollowed <= 1, "it never exceeds its bound");
  assert.ok(
    result.links.every((link) => !link.url.includes("look")),
    "and it never admits a lookalike",
  );
});

test("search aliases and cyclic related links read and admit each video once", async () => {
  const videos = [
    { id: "a1b2c3", title: "4979341 part 1", url: "https://www.eporner.com/video-a1b2c3/first/" },
    { id: "a1b2c3", title: "4979341 part 1", url: "https://www.eporner.com/video-a1b2c3/alias/" },
    { id: "d4e5f6", title: "4979341 part 2", url: "https://www.eporner.com/video-d4e5f6/second/" },
  ];
  const ids = ["a1b2c3", "d4e5f6", "z9y8x7"];
  const routes: Record<string, string> = {
    "https://www.eporner.com/api/v2/video/search/": JSON.stringify({ videos }),
  };
  for (const id of ids) {
    routes[`https://www.eporner.com/video-${id}/`] =
      fixture(`eporner-fc2-video-${id}.html`) +
      ids.map((other) => `<a href="/video-${other}/alias/">4979341</a>`).join("");
  }
  const fetcher = resolverFetcher(routes);
  const reads: string[] = [];
  const fetch = fetcher.fetch.bind(fetcher);
  fetcher.fetch = async (url) => {
    if (!url.includes("/api/")) reads.push(url);
    return fetch(url);
  };
  const lookup = createFc2EpornerResolver(fetcher, {
    sleep: noSleep,
    minIntervalMs: 0,
    relatedBound: 10,
  });
  const result = await lookup("4979341");
  assert.deepEqual(
    result.links.map((link) => link.url),
    [videos[0]!.url, videos[2]!.url, "https://www.eporner.com/video-z9y8x7/"],
  );
  assert.deepEqual(
    reads,
    result.links.map((link) => link.url),
  );
  assert.equal(result.candidatePagesRead, 3);
  assert.equal(result.relatedFollowed, 1);
  assert.equal(result.error, undefined);
});

/* ---- The scene-level lane -------------------------------------------------- */

test("an FC2 scene takes every verified upload, with parts where earned", async () => {
  const scene = makeScene({
    id: "fc2cmadb:4979341",
    sourceId: "fc2cmadb",
    releaseUrl: "https://fc2cmadb.com/articles/4979341",
  });
  const result = await resolveFc2Scene(scene, {
    now: NOW,
    lookup: async () =>
      lookupResult([
        { url: "https://www.eporner.com/video-a/", uploader: "U", part: 1 },
        { url: "https://www.eporner.com/video-b/", uploader: "U", part: 2 },
      ]),
  });
  assert.ok(result.matched);
  assert.equal(
    result.scene.videoUrls.length,
    2,
    "every verified upload is kept, not just the first",
  );
  assert.deepEqual(
    result.scene.videoUrls.map((link) => link.part),
    [1, 2],
  );
  assert.equal(result.scene.videoMatching?.lane, "fc2-eporner");
  assert.equal(result.scene.videoMatching?.confidence, "high");
});

test("a dead URL is never re-added by the FC2 lane", async () => {
  const scene = makeScene({
    id: "fc2cmadb:4979341",
    sourceId: "fc2cmadb",
    releaseUrl: "https://fc2cmadb.com/articles/4979341",
    deadVideoUrls: [
      {
        source: "eporner",
        url: "https://www.eporner.com/video-a/",
        deadAt: NOW.toISOString(),
        deadReason: "gone",
      },
    ],
  });
  const result = await resolveFc2Scene(scene, {
    now: NOW,
    lookup: async () =>
      lookupResult([
        { url: "https://www.eporner.com/video-a/", uploader: "U" },
        { url: "https://www.eporner.com/video-b/", uploader: "U" },
      ]),
  });
  assert.deepEqual(
    result.scene.videoUrls.map((link) => link.url),
    ["https://www.eporner.com/video-b/"],
  );
});

test("a lookup that throws links nothing rather than guessing", async () => {
  const scene = makeScene({
    id: "fc2cmadb:4979341",
    sourceId: "fc2cmadb",
    releaseUrl: "https://fc2cmadb.com/articles/4979341",
  });
  const rejections = emptyRejections();
  const result = await resolveFc2Scene(
    scene,
    {
      now: NOW,
      lookup: async () => {
        throw new Error("upstream down");
      },
    },
    rejections,
  );
  assert.equal(rejections.errored, 1, "a throw is an outage, not a clean no-match");
  assert.equal(result.matched, false);
  assert.deepEqual(result.scene.videoUrls, []);
  assert.ok(result.scene.videoCheckedAt, "but the scene is still stamped as looked at");
});

test("a record with no release code links nothing", async () => {
  const scene = makeScene({ id: "fc2cmadb:?", sourceId: "fc2cmadb" });
  const result = await resolveFc2Scene(scene, { now: NOW, lookup: async () => lookupResult([]) });
  assert.equal(result.matched, false);
});

/* ---- Regression: the other lanes are untouched ----------------------------- */

test("an FC2 scene never enters the ladder, and another lane never enters FC2", async () => {
  const fc2 = makeScene({
    id: "fc2cmadb:4979341",
    sourceId: "fc2cmadb",
    releaseUrl: "https://fc2cmadb.com/articles/4979341",
  });
  const lse = makeScene({
    id: "lancelot-styles-evolution:1",
    sourceId: "lancelot-styles-evolution",
  });
  let poolAsked = 0;
  let fc2Asked = 0;
  const result = await resolveLinks({
    scenes: [fc2, lse],
    now: NOW,
    mapWithConcurrency: (items, task) => Promise.all(items.map(task)),
    matcherFor: () => ({ matcher: "sxyprn+eporner", creatorStudio: false }),
    poolLookup: async () => {
      poolAsked += 1;
      return null;
    },
    sxyprnLookup: null,
    fc2Lookup: async () => {
      fc2Asked += 1;
      return lookupResult([{ url: "https://www.eporner.com/video-a/", uploader: "U" }]);
    },
  });
  assert.equal(poolAsked, 1, "the pool rung is asked about the non-FC2 scene only");
  assert.equal(fc2Asked, 1, "and never about the FC2 one");
  const byId = new Map(result.scenes.map((scene) => [scene.id, scene]));
  assert.equal(byId.get("fc2cmadb:4979341")?.videoUrls.length, 1);
  assert.equal(byId.get("lancelot-styles-evolution:1")?.videoUrls.length, 0);
  assert.deepEqual(result.rejections.attempted, 1, "only the non-FC2 scene counted a rung attempt");
});

test("a failed candidate page cannot create a verified link", async () => {
  const routes: Record<string, string> = { ...ROUTES };
  delete routes["https://www.eporner.com/video-d4e5f6/"];
  const lookup = createFc2EpornerResolver(resolverFetcher(routes), {
    sleep: noSleep,
    minIntervalMs: 0,
    relatedBound: 0,
  });
  const result = await lookup("4979341");
  assert.equal(result.links.length, 2);
  assert.ok(result.links.every((link) => !link.url.includes("d4e5f6")));
  assert.match(result.error ?? "", /HTTP 404/);
});

test("a page without exact-code hits does not hide a later matching page", async () => {
  const base = resolverFetcher(ROUTES);
  const fetcher: Fetcher = {
    ...base,
    async fetch(url) {
      if (url.includes("/api/")) {
        const page = Number(new URL(url).searchParams.get("page"));
        return Response.json({
          videos:
            page === 1
              ? [{ id: "look1", title: "14979341", url: "https://www.eporner.com/video-look1/" }]
              : page === 2
                ? [{ id: "a1b2c3", title: "4979341", url: "https://www.eporner.com/video-a1b2c3/" }]
                : [],
        });
      }
      return base.fetch(url);
    },
  };
  const lookup = createFc2EpornerResolver(fetcher, {
    sleep: noSleep,
    minIntervalMs: 0,
    relatedBound: 0,
  });
  const result = await lookup("4979341");
  assert.equal(result.links.length, 1);
  assert.equal(result.pagesRead, 3);
});

test("concurrent FC2 lookups share paced request starts", async () => {
  const starts: number[] = [];
  const fetcher: Fetcher = {
    ...resolverFetcher({}),
    async fetch() {
      starts.push(Date.now());
      return Response.json({ videos: [] });
    },
  };
  const lookup = createFc2EpornerResolver(fetcher, {
    minIntervalMs: 80,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  await Promise.all([lookup("4979341"), lookup("4981628"), lookup("4986883")]);
  assert.equal(starts.length, 3);
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i]! - starts[i - 1]! >= 70, `gap ${starts[i]! - starts[i - 1]!}ms`);
});

test("search durations cannot create parts when watch-page durations are unreadable", async () => {
  const search = JSON.stringify({
    videos: [
      {
        id: "a1b2c3",
        title: "4979341",
        url: "https://www.eporner.com/video-a1b2c3/",
        length_sec: 1180,
      },
      {
        id: "d4e5f6",
        title: "4979341",
        url: "https://www.eporner.com/video-d4e5f6/",
        length_sec: 1290,
      },
    ],
  });
  const page =
    '<h1>4979341</h1><li class="vit-uploader"><a href="/profile/OneUploader/">Uploader</a></li>';
  const lookup = createFc2EpornerResolver(
    resolverFetcher({
      "https://www.eporner.com/api/v2/video/search/": search,
      "https://www.eporner.com/video-a1b2c3/": page,
      "https://www.eporner.com/video-d4e5f6/": page,
    }),
    { sleep: noSleep, minIntervalMs: 0, relatedBound: 0 },
  );
  const result = await lookup("4979341");
  assert.equal(result.links.length, 2);
  assert.ok(result.links.every((link) => link.part === undefined));
});

test("the live watch page's duration cannot be replaced by a related upload's length", () => {
  const page = fixture("eporner-fc2-live-ME3XGKnqe88.html");
  assert.equal(epornerDurationFromPage(page), 2234);
  assert.equal(epornerUploaderFromPage(page), "isuca7567922");
});

test("a related video's uploader is not the main upload's account", () => {
  assert.equal(
    epornerUploaderFromPage(
      '<div class="related"><a href="/profile/OtherUploader/">Other</a></div>',
    ),
    null,
  );
});

test("an HTML challenge on a candidate page cannot turn a search hit into a verified link", async () => {
  const base = resolverFetcher(ROUTES);
  const fetcher: Fetcher = {
    ...base,
    async fetch(url) {
      return url.includes("/api/")
        ? base.fetch(url)
        : new Response("<html><h1>Verify you are human</h1><script>challenge()</script></html>", {
            headers: { "content-type": "text/html" },
          });
    },
  };
  const lookup = createFc2EpornerResolver(fetcher, {
    minIntervalMs: 0,
    sleep: noSleep,
    relatedBound: 0,
  });
  const result = await lookup("4979341");
  assert.deepEqual(result.links, []);
  assert.match(result.error ?? "", /exact-code video/);
});

test("part labels follow title order rather than ranking files by duration", () => {
  const parts = groupMultipart([
    { ...candidate("a", 1500, "Uploader"), title: "FC2-PPV-4979341 Part 1" },
    { ...candidate("b", 1200, "Uploader"), title: "FC2-PPV-4979341 Part 2" },
  ]);
  assert.equal(parts.get("https://www.eporner.com/video-a/"), 1);
  assert.equal(parts.get("https://www.eporner.com/video-b/"), 2);
});

test("unknown or conflicting title part numbers suppress labels for the whole group", () => {
  for (const title of ["4979341", "4979341 Part 1", "4979341 Part 2 Part 3"]) {
    const parts = groupMultipart([
      { ...candidate("a", 1500, "Uploader"), title: "4979341 Part 1" },
      { ...candidate("b", 1200, "Uploader"), title },
    ]);
    assert.equal(parts.size, 0);
  }
});

test("standalone release-code suffixes preserve the uploader's numbered parts", () => {
  const parts = groupMultipart([
    { ...candidate("a", 1500, "Uploader"), title: "4979341 1 [Release]" },
    { ...candidate("b", 1200, "Uploader"), title: "4979341-2" },
  ]);
  assert.equal(parts.get("https://www.eporner.com/video-a/"), 1);
  assert.equal(parts.get("https://www.eporner.com/video-b/"), 2);
});

test("long titles on live exact-code pages remain readable", () => {
  const title = titleFromPage(fixture("eporner-fc2-live-9oUclvtEj8J.html"));
  assert.ok(title);
  assert.ok(titleContainsExactCode(title, "4979341"));
});

test("the captured live search retains all five independently readable exact-code uploads", async () => {
  const search = fixture("eporner-fc2-live-search-4979341.json");
  const rows = (JSON.parse(search) as { videos: { id: string; url: string }[] }).videos;
  const routes: Record<string, string> = { "https://www.eporner.com/api/v2/video/search/": search };
  for (const row of rows) routes[row.url] = fixture(`eporner-fc2-live-${row.id}.html`);
  const lookup = createFc2EpornerResolver(resolverFetcher(routes), {
    searchPages: 1,
    relatedBound: 0,
    minIntervalMs: 0,
    sleep: noSleep,
  });
  const result = await lookup("4979341");
  assert.equal(result.error, undefined);
  assert.deepEqual(
    new Set(result.links.map((link) => link.url)),
    new Set(rows.map((row) => row.url)),
  );
  assert.equal(result.links.length, 5);
  assert.ok(result.links.every((link) => link.uploader !== null));
  assert.ok(
    result.links.every((link) => link.part === undefined),
    "the two actual uploaders cannot form one multipart group",
  );
});

test("an error-shaped JSON search response is reported as failure rather than clean absence", async () => {
  for (const body of [{ error: "temporarily unavailable" }, { videos: "changed" }, null]) {
    const fetcher: Fetcher = {
      ...resolverFetcher({}),
      async fetch() {
        return Response.json(body);
      },
    };
    const lookup = createFc2EpornerResolver(fetcher, { minIntervalMs: 0, sleep: noSleep });
    const result = await lookup("4979341");
    assert.deepEqual(result.links, []);
    assert.match(result.error ?? "", /malformed search/);
  }
});
