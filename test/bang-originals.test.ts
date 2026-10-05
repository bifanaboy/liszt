import assert from "node:assert/strict";
import test from "node:test";
import { createBangOriginalsStudio } from "../src/sources/bang-originals.ts";

const listing = (links: string[], pages = "") =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "SearchResultsPage",
    mainEntity: { itemListElement: links.map((url) => ({ "@type": "ListItem", url })) },
  })}</script>${pages}`;
const detail = (company = "Bang! Originals", date = "2026-10-05") =>
  `<script type="application/ld+json">${JSON.stringify({
    "@type": "VideoObject",
    name: "A verified scene",
    thumbnailUrl: "https://www.bang.com/thumb.jpg",
    datePublished: date,
    duration: "PT44M02S",
    productionCompany: { name: company },
  })}</script>`;

function context(pages: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      now: new Date("2026-10-05T00:00:00Z"),
      fetcher: {
        fetch: async () => {
          throw new Error("fetch is unused in this test");
        },
        text: async (url: string) => {
          calls.push(url);
          const page = pages[url];
          if (page === undefined) throw new Error(`unexpected URL ${url}`);
          return page;
        },
        json: async () => {
          throw new Error("json is unused in this test");
        },
      },
      mapWithConcurrency: async <T, R>(items: T[], task: (item: T, index: number) => Promise<R>) =>
        Promise.all(items.map(task)),
      mapIsolated: async <T, R>(items: T[], task: (item: T, index: number) => Promise<R>) =>
        Promise.all(items.map(task)),
      log() {},
    },
  };
}

test("Bang parses verified VideoObject records from listing pages", async () => {
  const scene = "https://www.bang.com/video/abc123/a-verified-scene";
  const listingUrl = "https://www.bang.com/videos?by=date.desc";
  const testctx = context({ [listingUrl]: listing([scene]), [scene]: detail() });
  const result = await createBangOriginalsStudio(listingUrl).fetch("2026-10-01", testctx.ctx);
  assert.equal(result.scenes.length, 1);
  assert.deepEqual(result.scenes[0], {
    sourceSceneId: "abc123",
    title: "A verified scene",
    releaseDate: "2026-10-05",
    performers: [],
    durationSec: 2642,
    thumbnailUrl: "https://www.bang.com/thumb.jpg",
    releaseUrl: scene,
    studioId: "bang-originals",
    studio: "Bang! Originals",
    provenance: {
      source: "Bang! Originals",
      sourceUrl: "https://www.bang.com/videos?by=date.desc",
      recordUrl: scene,
      sourceSceneId: "abc123",
    },
    fieldProvenance: {
      title: "Bang! Originals",
      releaseDate: "Bang! Originals",
      durationSec: "Bang! Originals",
      thumbnailUrl: "Bang! Originals",
    },
  });
  assert.equal(result.verifiedEmpty, false);
});

test("Bang rejects unknown companies and reports verified empty only after parsing", async () => {
  const scene = "https://www.bang.com/video/abc123/a-verified-scene";
  const listingUrl = "https://www.bang.com/videos?by=date.desc";
  const testctx = context({ [listingUrl]: listing([scene]), [scene]: detail("Other Studio") });
  const result = await createBangOriginalsStudio(listingUrl).fetch("2026-10-01", testctx.ctx);
  assert.equal(result.scenes.length, 0);
  assert.equal(result.verifiedEmpty, true);
});

test("Bang refuses off-host detail links", async () => {
  const listingUrl = "https://www.bang.com/videos?by=date.desc";
  const testctx = context({ [listingUrl]: listing(["https://attacker.invalid/video/x/y"]) });
  await assert.rejects(
    createBangOriginalsStudio(listingUrl).fetch("2026-10-01", testctx.ctx),
    /outside www\.bang\.com/i,
  );
});

test("Bang stops after a page whose releases all predate the requested window", async () => {
  const first = "https://www.bang.com/video/first/first-scene";
  const second = "https://www.bang.com/video/second/second-scene";
  const third = "https://www.bang.com/video/third/third-scene";
  const base = "https://www.bang.com/videos?by=date.desc";
  const next = (page: number) => `<a href="/videos?by=date.desc&page=${page}">Next</a>`;
  const testctx = context({
    [base]: listing([first], next(2)),
    ["https://www.bang.com/videos?by=date.desc&page=2"]: listing([second], `${next(2)}${next(3)}`),
    [first]: detail("Bang! Originals", "2026-10-05"),
    [second]: detail("Bang! Originals", "2026-09-30"),
  });
  const result = await createBangOriginalsStudio(base).fetch("2026-10-01", testctx.ctx);
  assert.equal(result.scenes.length, 1);
  assert.ok(!testctx.calls.includes(third));
  assert.equal(testctx.calls.length, 4);
});
