import assert from "node:assert/strict";
import test from "node:test";
import type { SourceContext } from "../src/sources/types.ts";
import { createMaximoGarciaStudio, isExcludedMaximoTitle } from "../src/sources/maximo-garcia.ts";

test("Maximo excludes the standalone trans title marker", () => {
  assert.equal(isExcludedMaximoTitle("Studio scene trans bonus"), true);
  assert.equal(isExcludedMaximoTitle("Studio scene TRANs bonus"), true);
  assert.equal(isExcludedMaximoTitle("Studio scene transport bonus"), false);
  assert.equal(isExcludedMaximoTitle("Studio scene transition bonus"), false);
});

for (const titles of [["Scene trans bonus"], ["Scene trans bonus", "Scene transport bonus"], []]) {
  test(`Maximo reports filtered IDs with ${titles.length} incoming records`, async () => {
    const createdAt = Date.parse("2026-10-02T00:00:00Z") / 1000;
    const media = {
      id: "video",
      accountId: "creator",
      type: 2,
      status: 1,
      mimetype: "video/mp4",
      flags: 0,
      width: 1280,
      height: 720,
      metadata: '{"duration":600}',
      updatedAt: createdAt,
      createdAt,
      locations: [],
    };
    const ctx: SourceContext = {
      now: new Date("2026-10-05T00:00:00Z"),
      log() {},
      mapWithConcurrency: async (items, task) => Promise.all(items.map(task)),
      mapIsolated: async (items, task) => Promise.all(items.map(task)),
      fetcher: {
        fetch: async () => {
          throw new Error("unexpected fetch");
        },
        text: async () => {
          throw new Error("unexpected text");
        },
        json: async <T>(url: string): Promise<T> =>
          ({
            success: true,
            response: url.includes("/account?")
              ? [{ id: "creator", username: "maximo_garcia", walls: [] }]
              : {
                  posts: titles.map((content, i) => ({
                    id: String(i),
                    accountId: "creator",
                    content,
                    fypFlags: 0,
                    createdAt,
                    attachments: [
                      { postId: String(i), pos: 0, contentType: 2, contentId: String(i) },
                    ],
                    likeCount: 0,
                    mediaLikeCount: 0,
                  })),
                  accountMedia: titles.map((_, i) => ({
                    id: String(i),
                    accountId: "creator",
                    mediaId: "video",
                    previewId: "preview",
                    permissionFlags: 0,
                    price: 0,
                    createdAt,
                    deleted: false,
                    access: true,
                    permissions: { permissionFlags: [] },
                    likeCount: 0,
                    media: { ...media, variants: [media] },
                  })),
                  accounts: [],
                },
          }) as T,
      },
    };
    const result = await createMaximoGarciaStudio().fetch("2026-10-01", ctx);
    assert.deepEqual(result.excludedSceneIds ?? [], titles.length ? ["fansly-0-0"] : []);
    assert.equal(result.verifiedEmpty, titles.length < 2);
    assert.equal(result.scenes.length, titles.length === 2 ? 1 : 0);
    if (result.scenes.length) {
      assert.equal(result.scenes[0]?.studioId, "maximo-garcia");
      assert.equal(result.scenes[0]?.provenance?.source, "Fansly");
    }
  });
}
