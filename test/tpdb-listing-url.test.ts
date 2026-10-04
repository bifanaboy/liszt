import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTpdbStudioUrl } from "../src/sources/studio-identity.ts";
import { buildDeclaration } from "../src/cli/link-studios-declaration.ts";

/**
 * A ThePornDB SEARCH address - the thing a person actually copies out of the
 * browser after filtering a site page - carries the studio in its query string,
 * not its path. The path is `/scenes`, a container view shared by every search,
 * so the identifier is `site_id`.
 *
 * Before this, such an address resolved to the candidate "scenes": the
 * container segment, not the studio. The lookup then fell back to a NAME
 * SEARCH, so it usually found the right site by luck and silently dropped every
 * tag in the address. These tests pin the parts that were lost.
 */

const bangSearch =
  "https://theporndb.net/scenes?orderBy=most_relevant&page=1&site=bang&site_id=988" +
  "&site_operation=Network&tag_and=0&tags%5B70%5D=Anal";

test("a search address takes the studio from site_id, not from the container path", () => {
  const lookup = parseTpdbStudioUrl(bangSearch);
  assert.deepEqual(lookup.candidates, ["988"]);
  assert.equal(lookup.name, "Bang");
});

test("a search address carries its tag names, and the bracket index is discarded", () => {
  const lookup = parseTpdbStudioUrl(bangSearch);
  assert.deepEqual(lookup.tags, ["Anal"]);
  // The bracket index is NOT a tag id. tags[70], tags[0] and tags[]= must all
  // produce the same lane, because TPDB's own tag filter ignores both the index
  // and the name (verified 2026-10-04: every tag value returned the same rows).
  const variants = [
    "https://theporndb.net/scenes?site_id=988&tags%5B70%5D=Anal",
    "https://theporndb.net/scenes?site_id=988&tags%5B0%5D=Anal",
    "https://theporndb.net/scenes?site_id=988&tags%5B%5D=Anal",
  ];
  for (const url of variants) {
    assert.deepEqual(parseTpdbStudioUrl(url).tags, ["Anal"], url);
  }
});

test("every tag in a multi-tag search is kept, de-duplicated and ordered", () => {
  // tag_and=1 states the operation explicitly: all of these tags.
  const lookup = parseTpdbStudioUrl(
    "https://theporndb.net/scenes?site_id=92&tag_and=1&tags%5B1%5D=Anal&tags%5B2%5D=BBC&tags%5B3%5D=Anal",
  );
  assert.deepEqual(lookup.tags, ["Anal", "BBC"]);
});

test("a search address with no tags still resolves its site", () => {
  // Tags are recorded, not required. A whole-site search is a legitimate
  // declaration; refusing it here would be a new rule, not a fix.
  const lookup = parseTpdbStudioUrl("https://theporndb.net/scenes?site_id=92");
  assert.deepEqual(lookup.candidates, ["92"]);
  assert.equal(lookup.tags, undefined);
});

test("a search address without a site_id is rejected rather than resolved by name", () => {
  // The old behaviour resolved this to the candidate "scenes" and then let a
  // NAME SEARCH pick a site. That is the silent wrong-studio path.
  assert.throws(
    () => parseTpdbStudioUrl("https://theporndb.net/scenes?tags%5B0%5D=Anal"),
    /site_id/,
  );
});

test("a site_id that is not a positive integer is rejected", () => {
  for (const value of ["abc", "0", "-5", "9.5", ""]) {
    assert.throws(
      () => parseTpdbStudioUrl(`https://theporndb.net/scenes?site_id=${value}`),
      /site_id/,
      value,
    );
  }
});

test("a site page address is unchanged and carries no tags", () => {
  const lookup = parseTpdbStudioUrl("https://theporndb.net/sites/brazzers");
  assert.deepEqual(lookup.candidates, ["brazzers"]);
  assert.equal(lookup.tags, undefined);
});

test("a search address that also names a uuid resolves by uuid, not by site_id", () => {
  const uuid = "e3b61b3e-0c20-4bea-9441-b88430ed6317";
  const lookup = parseTpdbStudioUrl(`https://theporndb.net/scenes?site_id=92&uuid=${uuid}`);
  assert.equal(lookup.uuid, uuid);
  assert.deepEqual(lookup.candidates, [uuid]);
});

test("a plain display name is kept out of the way when site_id is present", () => {
  // `site=bang` is a slug hint for the UI, not the identity. The id decides.
  const lookup = parseTpdbStudioUrl("https://theporndb.net/scenes?site=bang&site_id=988");
  assert.equal(lookup.name, "Bang");
  assert.deepEqual(lookup.candidates, ["988"]);
});

test("a search address's tags reach the declaration, so the lane is tag-scoped", () => {
  // This is the part that was silently lost: the declaration came out with no
  // `tags` at all, so the lane collected EVERY new BANG! scene rather than only
  // the anal ones the address asked for.
  const link = buildDeclaration({
    lookup: parseTpdbStudioUrl(bangSearch),
    resolved: {
      siteId: 988,
      uuid: "ff181a21-1856-4230-a66e-acb93b247e84",
      name: "BANG!",
      shortName: "bang",
      url: "https://www.bang.com",
      networkId: undefined,
      resolvedBy: "id",
    },
    studioName: "Bang",
  });
  assert.deepEqual(link.tags, ["Anal"]);
  // The tag scope is part of the key, so the tagged and untagged lanes for one
  // site are two lanes rather than one lane silently changing scope.
  assert.equal(link.studioId, "tpdb-bang-anal");
  assert.equal(link.tpdb?.siteId, 988);
});

test("a Traxxx side still contributes its own tags and lane id", () => {
  // The existing behaviour must be untouched: a Traxxx lane's tags and its
  // kind-slug-tags id both still win over the TPDB-only `tpdb-` namespace.
  const link = buildDeclaration({
    lane: {
      kind: "network",
      slug: "bang",
      tags: ["anal"],
      url: "https://traxxx.me/network/bang/scenes/latest/1?tags=anal",
    },
    lookup: parseTpdbStudioUrl(bangSearch),
    resolved: {
      siteId: 988,
      uuid: undefined,
      name: "BANG!",
      shortName: "bang",
      url: undefined,
      networkId: undefined,
      resolvedBy: "search",
    },
    studioName: "Bang",
  });
  assert.equal(link.studioId, "network-bang-anal");
  assert.deepEqual(link.tags, ["anal"]);
});

test("the tag filter is applied by name, never forwarded to the TPDB API", async () => {
  // TPDB's own tags[...] parameter does not filter, so forwarding it would
  // silently narrow the lane to an arbitrary subset. The request carries
  // site_id and the date window and nothing else.
  const { createTpdbWatchlistSource } = await import("../src/sources/tpdb-watchlist.ts");
  const requested: string[] = [];
  const ctx = {
    now: new Date("2026-10-04T00:00:00Z"),
    fetcher: {
      json: async (url: string) => {
        requested.push(url);
        return { data: [], meta: { current_page: 1, last_page: 1 } };
      },
    },
    log: () => {},
    mapWithConcurrency: async (items: unknown[], fn: (item: unknown) => unknown) =>
      Promise.all(items.map(fn)),
    mapIsolated: async (items: unknown[], fn: (item: unknown) => unknown) =>
      Promise.all(items.map(fn)),
  };
  const source = createTpdbWatchlistSource({
    token: "t",
    studios: [
      { studioId: "tpdb-bang", studio: "Bang", aliases: ["Bang"], tags: ["Anal"], siteId: 988 },
    ],
  });
  await source.fetch("2026-09-01", ctx as never);
  assert.ok(requested.length > 0, "the lane issued no request");
  for (const url of requested) {
    assert.match(url, /site_id=988/);
    assert.doesNotMatch(url, /tags/i);
  }
});
