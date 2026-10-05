import { test } from "node:test";
import assert from "node:assert/strict";
import { createBangOriginalsStudio } from "../src/sources/bang-originals.ts";
import { createMaximoGarciaStudio } from "../src/sources/maximo-garcia.ts";
import type { SourceContext } from "../src/sources/types.ts";

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

const noRequests = context(async () => {
  throw new Error("Unexpected JSON request");
});

test("Bang emits no fabricated release and does not verify an unparsed listing as empty", async () => {
  const source = createBangOriginalsStudio("https://www.analvids.com/listing");
  for (const windowStart of ["2026-10-01", "2026-10-06"]) {
    assert.deepEqual(await source.fetch(windowStart, noRequests), {
      scenes: [],
      verifiedEmpty: false,
    });
  }
});

test("Bang still requires its listing URL", async () => {
  await assert.rejects(
    createBangOriginalsStudio().fetch("2026-10-01", noRequests),
    /not configured/,
  );
});

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
