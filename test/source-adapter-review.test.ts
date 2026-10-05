import { test } from "node:test";
import assert from "node:assert/strict";
import { createMaximoGarciaStudio } from "../src/sources/maximo-garcia.ts";
import { applyStudioPolicy } from "../src/sources/studio-policy.ts";
import type { SourceAdapter, SourceContext } from "../src/sources/types.ts";

function context(json: SourceContext["fetcher"]["json"]): SourceContext {
  return {
    now: new Date("2026-10-05T12:00:00Z"),
    fetcher: {
      json,
      fetch: async () => {
        throw new Error("Unexpected fetch");
      },
      text: async () => {
        throw new Error("Unexpected text request");
      },
    },
    log: () => {},
    mapWithConcurrency: async (items, task) => Promise.all(items.map(task)),
    mapIsolated: async (items, task) => Promise.all(items.map(task)),
  };
}

test("Maximo preserves Fansly evidence and filters releases using the supplied window", async () => {
  const dates = ["2026-10-01T00:00:00Z", "2026-09-30T23:59:59Z", "2026-10-05T12:00:01Z"];
  const posts = dates.map((date, index) => ({
    id: `post-${index}`,
    accountId: "creator",
    content: "Release title",
    fypFlags: 0,
    createdAt: Date.parse(date) / 1000,
    likeCount: 0,
    mediaLikeCount: 0,
    attachments: [{ postId: `post-${index}`, pos: 0, contentType: 2, contentId: "video" }],
  }));
  const requests: string[] = [];
  const ctx = context(async <T>(url: string): Promise<T> => {
    requests.push(url);
    assert.equal(new URL(url).origin, "https://apiv3.fansly.com");
    if (new URL(url).pathname === "/api/v1/account") {
      assert.equal(new URL(url).searchParams.get("usernames"), "maximo_garcia");
      return {
        success: true,
        response: [{ id: "creator", username: "maximo_garcia", walls: [] }],
      } as T;
    }
    assert.equal(new URL(url).pathname, "/api/v1/timelinenew/creator");
    return {
      success: true,
      response: {
        posts,
        accounts: [],
        accountMedia: [
          {
            id: "video",
            accountId: "creator",
            mediaId: "media",
            previewId: "preview",
            permissionFlags: 0,
            price: 0,
            createdAt: 0,
            deleted: false,
            access: true,
            permissions: { permissionFlags: [] },
            likeCount: 0,
            media: {
              id: "media",
              type: 2,
              status: 0,
              accountId: "creator",
              mimetype: "video/mp4",
              flags: 0,
              width: 640,
              height: 480,
              metadata: '{"duration":120}',
              updatedAt: 0,
              createdAt: 0,
              locations: [],
              variants: [
                {
                  id: "variant",
                  type: 302,
                  status: 0,
                  mimetype: "video/mp4",
                  flags: 0,
                  width: 640,
                  height: 480,
                  metadata: "{}",
                  updatedAt: 0,
                  locations: [],
                },
              ],
            },
          },
        ],
      },
    } as T;
  });
  const source = createMaximoGarciaStudio();
  assert.match(source.authority.role, /Fansly/);
  assert.doesNotMatch(JSON.stringify(source.authority), /composite|TPDB|ManyVids/i);
  const result = await source.fetch("2026-10-01", ctx);
  assert.equal(requests.length, 2);
  assert.equal(result.scenes.length, 1);
  assert.equal(result.verifiedEmpty, false);
  const scene = result.scenes[0]!;
  assert.equal(scene.studioId, "maximo-garcia");
  assert.equal(scene.studio, "Maximo Garcia");
  assert.equal(scene.releaseDate, "2026-10-01");
  assert.equal(scene.durationSec, 120);
  assert.deepEqual(scene.provenance, {
    source: "Fansly",
    sourceUrl: "https://apiv3.fansly.com",
    recordUrl: "https://fansly.com/post/post-0",
    sourceSceneId: "post-0",
  });
  assert.deepEqual(scene.fieldProvenance, {
    title: "Fansly",
    releaseDate: "Fansly",
    durationSec: "Fansly",
  });
});

test("split studio policy preserves each studio identity emitted by a feed", async () => {
  const source: SourceAdapter = {
    id: "provider",
    name: "Provider",
    authority: { name: "Provider", url: "https://example.test/feed", role: "Test feed" },
    matcher: null,
    async fetch() {
      return {
        verifiedEmpty: false,
        scenes: [
          {
            sourceSceneId: "one",
            title: "One",
            releaseDate: "2026-10-01",
            performers: [],
            studioId: "first",
            studio: "First",
          },
          {
            sourceSceneId: "two",
            title: "Two",
            releaseDate: "2026-10-01",
            performers: [],
            studioId: "second",
            studio: "Second",
          },
        ],
      };
    },
  };
  const result = await applyStudioPolicy(source, {
    adapterId: source.id,
    sourceUrl: source.authority.url,
    studioPolicy: { mode: "split" },
  }).fetch("2026-10-01", {} as SourceContext);
  assert.deepEqual(
    result.scenes.map((scene) => scene.studioId),
    ["first", "second"],
  );
});

test("split studio policy marks records with no studio identity for review", async () => {
  const source: SourceAdapter = {
    id: "provider",
    name: "Provider",
    authority: { name: "Provider", url: "https://example.test/feed", role: "Test feed" },
    matcher: null,
    async fetch() {
      return {
        verifiedEmpty: false,
        scenes: [{ sourceSceneId: "one", title: "One", releaseDate: "2026-10-01", performers: [] }],
      };
    },
  };
  const result = await applyStudioPolicy(source, {
    adapterId: source.id,
    sourceUrl: source.authority.url,
    studioPolicy: { mode: "split" },
  }).fetch("2026-10-01", {} as SourceContext);

  assert.equal(result.scenes[0]!.studioIdentityMissing, true);
  assert.equal(result.scenes[0]!.metadataPoor, true);
  assert.equal(result.scenes[0]!.studioId, undefined);
});

test("umbrella studio policy assigns every feed record to its declared alias", async () => {
  const source: SourceAdapter = {
    id: "provider",
    name: "Provider",
    authority: { name: "Provider", url: "https://example.test/feed", role: "Test feed" },
    matcher: null,
    async fetch() {
      return {
        verifiedEmpty: false,
        scenes: [
          {
            sourceSceneId: "one",
            title: "One",
            releaseDate: "2026-10-01",
            performers: [],
            studioId: "first",
            studio: "First",
          },
          {
            sourceSceneId: "two",
            title: "Two",
            releaseDate: "2026-10-01",
            performers: [],
            studioId: "second",
            studio: "Second",
          },
        ],
      };
    },
  };
  const result = await applyStudioPolicy(source, {
    adapterId: source.id,
    sourceUrl: source.authority.url,
    studioPolicy: { mode: "umbrella", studioId: "DreddXXX", studio: "DreddXXX" },
  }).fetch("2026-10-01", {} as SourceContext);
  assert.deepEqual(
    result.scenes.map((scene) => scene.studioId),
    ["DreddXXX", "DreddXXX"],
  );
  assert.deepEqual(
    result.scenes.map((scene) => scene.studio),
    ["DreddXXX", "DreddXXX"],
  );
  assert.deepEqual(
    result.scenes.map((scene) => scene.providerStudioId),
    ["first", "second"],
  );
});
