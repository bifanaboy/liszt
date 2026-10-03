import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import {
  TRAXXX_WATCHLIST,
  createTraxxxLaneIds,
  createTraxxxWatchlistStudios,
  parseTraxxxListingUrl,
} from "../src/sources/traxxx-watchlist.ts";
import { createSources } from "../src/sources/registry.ts";

test("parses supported network and channel listings with tag slugs", () => {
  assert.deepEqual(
    parseTraxxxListingUrl("https://traxxx.me/network/vixen/scenes/latest/1?tags=anal,bbc"),
    {
      id: "vixen-anal-bbc",
      kind: "network",
      slug: "vixen",
      tags: ["anal", "bbc"],
      url: "https://traxxx.me/network/vixen/scenes/latest/1?tags=anal%2Cbbc",
    },
  );
  assert.deepEqual(parseTraxxxListingUrl("https://www.traxxx.me/channel/tushy/scenes/latest/1"), {
    id: "tushy",
    kind: "channel",
    slug: "tushy",
    tags: [],
    url: "https://www.traxxx.me/channel/tushy/scenes/latest/1",
  });
});

for (const [name, url] of [
  ["foreign host", "https://example.com/network/vixen/scenes/latest/1?tags=anal"],
  ["unsupported sort", "https://traxxx.me/network/vixen/scenes/popular/1?tags=anal"],
  ["page other than one", "https://traxxx.me/network/vixen/scenes/latest/2?tags=anal"],
  ["unknown query", "https://traxxx.me/network/vixen/scenes/latest/1?tags=anal&foo=bar"],
  ["empty tag", "https://traxxx.me/network/vixen/scenes/latest/1?tags="],
] as const) {
  test("rejects a " + name + " and names the URL", () => {
    assert.throws(
      () => parseTraxxxListingUrl(url),
      (error) => error instanceof Error && error.message.includes(url),
    );
  });
}

test("the default watchlist creates the Vixen anal lane and stable lane ids", () => {
  assert.deepEqual(TRAXXX_WATCHLIST, ["https://traxxx.me/network/vixen/scenes/latest/1?tags=anal"]);
  assert.deepEqual(createTraxxxLaneIds(TRAXXX_WATCHLIST), ["vixen-anal"]);
  const [lane] = createTraxxxWatchlistStudios(TRAXXX_WATCHLIST);
  assert.equal(lane?.id, "vixen-anal");
});

test("configuration replaces the default watchlist and empty input keeps the default", () => {
  const custom = "https://traxxx.me/channel/tushy/scenes/latest/1?tags=anal";
  assert.deepEqual(loadConfig({ LISZT_TRAXXX_WATCHLIST: custom }).traxxxWatchlist, [custom]);
  assert.deepEqual(loadConfig({ LISZT_TRAXXX_WATCHLIST: "  " }).traxxxWatchlist, [
    ...TRAXXX_WATCHLIST,
  ]);
});

test("the registry replaces the retired Tushy lane with watchlist lanes", () => {
  const ids = createSources({
    madouquApiBase: "https://example.test",
    traxxxWatchlist: TRAXXX_WATCHLIST,
  }).map((source) => source.id);
  assert.ok(ids.includes("vixen-anal"));
  assert.ok(!ids.includes("tushy"));
});
