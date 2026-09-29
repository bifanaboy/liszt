import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSearchUrl,
  epornerVideoId,
  epornerWatchUrl,
  matchEpornerOpen,
  validEpornerEmbedUrl,
  validEpornerUrl,
} from "../src/tubes/eporner.ts";

test("the open-search request always carries an explicit lq", () => {
  const url = new URL(buildSearchUrl("marfe", { lq: 0 }));
  assert.equal(url.searchParams.get("lq"), "0");
  assert.equal(new URL(buildSearchUrl("marfe", { lq: 1 })).searchParams.get("lq"), "1");
});

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

test("matchEpornerOpen rejects a row whose URL or embed is invalid", () => {
  const scene = {
    id: "s:1",
    title: "Marfe takes it deep",
    source: "test",
    sourceId: "test",
    label: "Test",
    performers: ["Marfe okkk"],
    releaseDate: "2026-03-04",
    durationSec: 600,
  };
  const valid = {
    url: "https://www.eporner.com/video-abc/",
    embed: "https://www.eporner.com/embed/abc/",
    title: "Marfe takes it deep",
    length_sec: 600,
    // The open-search row carries its upload date for free, so this rung runs
    // the date half at zero extra requests.
    added: "2026-03-05 10:00:00",
  };
  const gate = { dateWindowDays: 7 };
  assert.ok(matchEpornerOpen(scene, [valid], gate));
  assert.equal(matchEpornerOpen(scene, [{ ...valid, url: "https://evil.example/video-abc/" }], gate), null);
  // Same rule as every other rung: outside the window is a rejection.
  assert.equal(matchEpornerOpen(scene, [{ ...valid, added: "2026-05-01 10:00:00" }], gate), null);
  assert.equal(matchEpornerOpen(scene, [{ ...valid, added: null }], gate), null);
});