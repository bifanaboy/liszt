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
import { classifyScene, decodeRenderedHtml, parsePost } from "../src/sources/madouqu.ts";

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
    { id: undefined, slug: "marfe-okkk", title: { rendered: TITLE }, date_gmt: "2026-03-04T00:00:00" },
    category,
    verdict,
    { sourceUrl: "https://example.test/posts", base: "https://example.test" },
  );
  assert.equal(fromSlug.sourceSceneId, "marfe-okkk");

  const fromLink = parsePost(
    { id: undefined, link: "https://madouqu.com/2026/03/marfe-okkk/", title: { rendered: TITLE }, date_gmt: "2026-03-04T00:00:00" },
    category,
    verdict,
    { sourceUrl: "https://example.test/posts", base: "https://example.test" },
  );
  assert.equal(fromLink.sourceSceneId, "https://madouqu.com/2026/03/marfe-okkk/");

  // Two distinct posts with no id at all must not share a key.
  assert.notEqual(fromSlug.sourceSceneId, fromLink.sourceSceneId);
});
