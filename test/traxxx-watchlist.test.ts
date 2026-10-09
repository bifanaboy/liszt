import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfigForTest as loadConfig } from "./test-config.ts";
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

test("the default watchlist creates the intended lanes and stable lane ids", () => {
  assert.deepEqual(TRAXXX_WATCHLIST, [
    "https://traxxx.me/channel/elegantangel/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/brazzers/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/bangbros/scenes/latest/1?tags=anal",
    "https://traxxx.me/channel/disciplesofdesire/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/bang/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/mikeadriano/scenes/latest/1?tags=anal",
    "https://traxxx.me/channel/hookuphotshot/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/julesjordan/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/xempire/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/teamskeet/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/pervcity/scenes/latest/1?tags=anal",
    "https://traxxx.me/channel/rickysroom/scenes/latest/1?tags=anal",
    "https://traxxx.me/network/exploitedx/scenes/latest/1?tags=anal",
    "https://traxxx.me/channel/herlimit/scenes/latest/1?tags=anal",
    "https://traxxx.me/channel/natashateenfilms/scenes/latest/1",
    "https://traxxx.me/network/firstanalquest/scenes/latest/1",
    "https://traxxx.me/channel/wakeupnfuck/scenes/latest/1",
    "https://traxxx.me/channel/darkkotv/scenes/latest/1?tags=anal",
  ]);
  const expectedIds = [
    "channel-elegantangel-anal",
    "network-brazzers-anal",
    "network-bangbros-anal",
    "channel-disciplesofdesire-anal",
    "network-bang-anal",
    "network-mikeadriano-anal",
    "channel-hookuphotshot-anal",
    "network-julesjordan-anal",
    "network-xempire-anal",
    "network-teamskeet-anal",
    "network-pervcity-anal",
    "channel-rickysroom-anal",
    "network-exploitedx-anal",
    "channel-herlimit-anal",
    "channel-natashateenfilms",
    "network-firstanalquest",
    "channel-wakeupnfuck",
    "channel-darkkotv-anal",
  ];
  assert.deepEqual(createTraxxxLaneIds(TRAXXX_WATCHLIST), expectedIds);
  assert.deepEqual(
    createTraxxxWatchlistStudios(TRAXXX_WATCHLIST).map((lane) => lane.id),
    expectedIds,
  );
});

test("Vixen remains available as a custom Traxxx network lane", () => {
  const url = "https://traxxx.me/network/vixen/scenes/latest/1?tags=anal";
  assert.deepEqual(createTraxxxLaneIds([url]), ["network-vixen-anal"]);
  assert.deepEqual(
    createTraxxxWatchlistStudios([url]).map((lane) => lane.id),
    ["network-vixen-anal"],
  );
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
  for (const id of createTraxxxLaneIds(TRAXXX_WATCHLIST)) {
    assert.equal(ids.filter((sourceId) => sourceId === id).length, 1, id);
  }
  assert.ok(
    ids.some((id) => id.includes("bang")),
    "Bang comes from its Traxxx network watchlist lane",
  );
  assert.ok(ids.includes("maximo-garcia"));
  assert.ok(!ids.includes("tpdb-watchlist"), "TPDB stays disabled until an API key is set");
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
    [
      "https://traxxx.me/network/vixen-anal/scenes/latest/1",
      "https://traxxx.me/network/vixen/scenes/latest/1?tags=anal",
    ],
  ]) {
    assert.throws(() => createTraxxxWatchlistStudios(urls), /Duplicate Traxxx watchlist ID/);
  }
});

test("watchlist rejects reserved IDs", () => {
  assert.throws(
    () => createTraxxxWatchlistStudios(TRAXXX_WATCHLIST, ["network-brazzers-anal"]),
    /Reserved Traxxx watchlist ID "network-brazzers-anal"/,
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
