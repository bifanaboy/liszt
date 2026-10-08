import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTraxxxListingUrl } from "../lib/sources/traxxx-watchlist.js";

test("Traxxx listing URLs normalize tags and stable lane ids", () => {
  assert.deepEqual(
    parseTraxxxListingUrl("https://traxxx.me/network/vixen/scenes/latest/1?tags=anal,bbc"),
    {
      id: "network-vixen-anal-bbc",
      kind: "network",
      slug: "vixen",
      tags: ["anal", "bbc"],
      url: "https://traxxx.me/network/vixen/scenes/latest/1?tags=anal%2Cbbc",
    },
  );
});

test("Traxxx listing URLs reject foreign hosts and unsupported query values", () => {
  assert.throws(
    () => parseTraxxxListingUrl("https://example.com/network/vixen/scenes/latest/1"),
    /host/,
  );
  assert.throws(
    () => parseTraxxxListingUrl("https://traxxx.me/network/vixen/scenes/latest/1?unknown=x"),
    /query/,
  );
});
