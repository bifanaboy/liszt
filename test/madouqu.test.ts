/**
 * The madouqu classifier, asserted on the two properties that make it usable
 * as a gate rather than as a source of noise.
 *
 *  - DETERMINISM. The pattern table is module-level, so a `/g` flag on any
 *    pattern makes `.test()` stateful across calls: identical text flips
 *    verdict between polls, and each call in isolation looks correct. The test
 *    therefore calls the classifier repeatedly on the SAME input.
 *  - NO UNTRUSTED THROW. Titles and bodies are remote text, and one hostile
 *    entity must not abort a whole poll.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyScene,
  createMadouquStudio,
  decodeRenderedHtml,
  parsePost,
  STUDIO_CATEGORIES,
} from "../src/sources/madouqu.ts";

const TITLE = "Marfe okkk 肛交 菊穴 back door anal creampie";
const BODY = "The scene opens with an anal scene and then the money shot.";

test("classification is deterministic across repeated calls on identical text", () => {
  const first = classifyScene(TITLE, BODY);
  for (let round = 0; round < 50; round += 1) {
    const again = classifyScene(TITLE, BODY);
    assert.equal(again.decision, first.decision, `verdict flipped on round ${round}`);
    assert.deepEqual(again.matchedKeywords, first.matchedKeywords);
  }
  assert.equal(first.decision, "admit");
  assert.ok(first.matchedKeywords.includes("肛交"));
});

test("minor and coercion terms block the post in either title or body", () => {
  const terms = [
    "萝莉",
    "蘿莉",
    "幼女",
    "未成年",
    "初中",
    "小学",
    "小學",
    "迷奸",
    "迷姦",
    "强奸",
    "強姦",
    "昏迷",
    "偷拍",
  ];
  for (const term of terms) {
    for (const field of ["title", "body"] as const) {
      const verdict = classifyScene(
        field === "title" ? `${term} 肛交` : "肛交",
        field === "body" ? term : "",
      );
      assert.equal(verdict.decision, "excluded", `${term} in ${field}`);
      assert.equal(verdict.reason, "safety:blocked", `${term} in ${field}`);
      assert.ok(verdict.exclusionKeywords?.includes(term), `${term} is recorded in ${field}`);
    }
  }
});

test("the live category ids are unique and include the two verified labels", () => {
  const ids = STUDIO_CATEGORIES.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(
    STUDIO_CATEGORIES.filter(({ id }) => id === 779 || id === 720).map(({ id, key, name }) => ({
      id,
      key,
      name,
    })),
    [
      { id: 779, key: "xingba", name: "Xingba Media" },
      { id: 720, key: "tangxin", name: "Tangxin VLOG" },
    ],
  );
});

test("madouqu remains explicitly metadata-only even when records carry performers", () => {
  assert.equal(createMadouquStudio({ apiBase: "https://example.test/wp/v2" }).matcher, null);
});

test("an out-of-range entity does not throw, and does not abort the poll", () => {
  // `String.fromCodePoint` throws a RangeError outside 0..0x10FFFF. Titles are
  // remote text, so an undecodable entity degrades one character and nothing
  // more - it used to reject the whole fetch.
  assert.equal(decodeRenderedHtml("a&#999999999;b"), "ab");
  assert.equal(decodeRenderedHtml("a&#xFFFFFFFF;b"), "ab");
  assert.equal(decodeRenderedHtml("a&#xD800;b"), "ab");
  assert.equal(decodeRenderedHtml("a&#128512;b"), "a😀b");
  assert.equal(decodeRenderedHtml("a&#x1F600;b"), "a😀b");
  assert.doesNotThrow(() => classifyScene("&#999999999; anal", "anal"));
});

test("a post with no id falls back to a stable key instead of the empty one", () => {
  // Without a fallback every id-less post collapsed onto `""` and overwrote the
  // others - in the lane's dedupe map and in the store's upsert alike.
  const verdict = classifyScene(TITLE, BODY);
  const category = { id: 2, key: "madou", name: "Madou" } as const;
  const fromSlug = parsePost(
    {
      id: undefined,
      slug: "marfe-okkk",
      title: { rendered: TITLE },
      date_gmt: "2026-03-04T00:00:00",
    },
    category,
    verdict,
    { sourceUrl: "https://example.test/posts", base: "https://example.test" },
  );
  assert.equal(fromSlug.sourceSceneId, "marfe-okkk");

  const fromLink = parsePost(
    {
      id: undefined,
      link: "https://madouqu.com/2026/03/marfe-okkk/",
      title: { rendered: TITLE },
      date_gmt: "2026-03-04T00:00:00",
    },
    category,
    verdict,
    { sourceUrl: "https://example.test/posts", base: "https://example.test" },
  );
  assert.equal(fromLink.sourceSceneId, "https://madouqu.com/2026/03/marfe-okkk/");

  // Two distinct posts with no id at all must not share a key.
  assert.notEqual(fromSlug.sourceSceneId, fromLink.sourceSceneId);
});

test("performers come only from the observed labeled excerpt field", () => {
  const category = { id: 779, key: "xingba", name: "Xingba Media" } as const;
  const verdict = classifyScene("肛交", "肛交");
  const scene = parsePost(
    {
      id: 91985,
      title: { rendered: "示例场景肛交" },
      content: { rendered: "<p>杏吧片名：示例场景肛交 麻豆女郎 ：空空子 下载地址：Magnet</p>" },
      date_gmt: "2026-03-04T00:00:00",
    },
    category,
    verdict,
    { sourceUrl: "https://example.test/posts", base: "https://example.test" },
  );
  assert.deepEqual(scene.performers, ["空空子"]);
  assert.equal(scene.fieldProvenance?.performers, "madouqu:excerpt");

  const empty = parsePost(
    {
      id: 91975,
      title: { rendered: "示例场景肛交" },
      content: { rendered: "杏吧片名：示例场景肛交 麻豆女郎： 下载地址：Magnet" },
      date_gmt: "2026-03-04T00:00:00",
    },
    category,
    verdict,
    { sourceUrl: "https://example.test/posts", base: "https://example.test" },
  );
  assert.deepEqual(empty.performers, []);
  assert.equal(empty.fieldProvenance?.performers, undefined);
});
