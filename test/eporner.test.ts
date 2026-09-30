import { test } from "node:test";
import assert from "node:assert/strict";
import {
  epornerVideoId,
  epornerWatchUrl,
  validEpornerEmbedUrl,
  validEpornerUrl,
} from "../src/tubes/eporner.ts";

test("eporner URL validators accept both watch shapes and the embed shape", () => {
  assert.ok(validEpornerUrl("https://www.eporner.com/video-abc123/"));
  assert.ok(validEpornerUrl("https://www.eporner.com/hd-porn/abc123/some-title/"));
  assert.ok(validEpornerEmbedUrl("https://www.eporner.com/embed/abc123/"));
  assert.equal(validEpornerUrl("https://evil.example/video-abc123/"), false);
  assert.equal(validEpornerUrl("http://www.eporner.com/video-abc123/"), false);
  assert.equal(validEpornerUrl("https://www.eporner.com/video-abc123/?x=1"), false);
  assert.equal(validEpornerEmbedUrl("https://www.eporner.com/embed/abc123/?x=1"), false);
});

test("epornerVideoId extracts the id from either shape", () => {
  assert.equal(epornerVideoId("https://www.eporner.com/video-abc123/"), "abc123");
  assert.equal(epornerVideoId("https://www.eporner.com/hd-porn/xyz789/"), "xyz789");
  assert.equal(epornerVideoId("not a url"), null);
  assert.equal(epornerWatchUrl("abc123"), "https://www.eporner.com/video-abc123/");
});
