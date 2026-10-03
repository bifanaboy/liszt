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
import { WOODMAN_CASTING_X_SLUG } from "../src/sources/woodman-casting-x.ts";

test("parses supported network and channel listings with tag slugs", () => {
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
  assert.deepEqual(parseTraxxxListingUrl("https://www.traxxx.me/channel/tushy/scenes/latest/1"), {
    id: "channel-tushy",
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
  assert.deepEqual(createTraxxxLaneIds(TRAXXX_WATCHLIST), ["network-vixen-anal"]);
  const [lane] = createTraxxxWatchlistStudios(TRAXXX_WATCHLIST);
  assert.equal(lane?.id, "network-vixen-anal");
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
  assert.ok(ids.includes("network-vixen-anal"));
  assert.ok(!ids.includes("tushy"));
});

test("tag order is canonical and channel and network lane IDs differ", () => {
  const first = parseTraxxxListingUrl(
    "https://traxxx.me/network/vixen/scenes/latest/1?tags=bbc,anal",
  );
  const second = parseTraxxxListingUrl(
    "https://traxxx.me/network/vixen/scenes/latest/1?tags=anal,bbc",
  );
  assert.deepEqual(first, second);
  const channel = parseTraxxxListingUrl(
    "https://traxxx.me/channel/vixen/scenes/latest/1?tags=anal,bbc",
  );
  assert.notEqual(first.id, channel.id);
});

test("watchlist rejects duplicate IDs, including reordered tags and ambiguous slugs", () => {
  for (const urls of [
    [TRAXXX_WATCHLIST[0]!, TRAXXX_WATCHLIST[0]!],
    [
      "https://traxxx.me/network/vixen/scenes/latest/1?tags=bbc,anal",
      "https://traxxx.me/network/vixen/scenes/latest/1?tags=anal,bbc",
    ],
    ["https://traxxx.me/network/vixen-anal/scenes/latest/1", TRAXXX_WATCHLIST[0]!],
  ]) {
    assert.throws(() => createTraxxxWatchlistStudios(urls), /Duplicate Traxxx watchlist ID/);
  }
});

test("watchlist rejects reserved IDs", () => {
  assert.throws(
    () => createTraxxxWatchlistStudios(TRAXXX_WATCHLIST, ["network-vixen-anal"]),
    /Reserved Traxxx watchlist ID "network-vixen-anal"/,
  );
});

test("the registry rejects Woodman channel watchlists with or without tags", () => {
  for (const slug of [WOODMAN_CASTING_X_SLUG, WOODMAN_CASTING_X_SLUG.toUpperCase()]) {
    for (const query of ["", "?tags=anal", "?tags=bbc,anal"]) {
      assert.throws(
        () =>
          createSources({
            madouquApiBase: "https://example.test",
            traxxxWatchlist: [`https://traxxx.me/channel/${slug}/scenes/latest/1${query}`],
          }),
        /Reserved Traxxx watchlist channel/,
      );
    }
  }
});

test("the Woodman watchlist reservation applies only to the channel namespace", () => {
  const [lane] = createTraxxxWatchlistStudios([
    `https://traxxx.me/network/${WOODMAN_CASTING_X_SLUG}/scenes/latest/1`,
  ]);
  assert.equal(lane?.id, `network-${WOODMAN_CASTING_X_SLUG}`);
});
