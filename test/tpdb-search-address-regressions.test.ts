import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTpdbStudioUrl,
  resolveTpdbSite,
  type TpdbLookup,
} from "../src/sources/studio-identity.ts";
import { buildDeclaration, lookupForResolver } from "../src/cli/link-studios-declaration.ts";
import { FetchError } from "../src/core/fetcher.ts";
import type { Fetcher } from "../src/sources/types.ts";

/**
 * Regressions found in review of the TPDB search-address change. Each names a
 * path where the first implementation was wrong, not just untidy.
 */

const bangSite = {
  id: 988,
  uuid: "ff181a21-1856-4230-a66e-acb93b247e84",
  name: "BANG!",
  short_name: "bang",
};
const brazzers = {
  id: 92,
  uuid: "e3b61b3e-0c20-4bea-9441-b88430ed6317",
  name: "Brazzers",
  short_name: "brazzers",
  url: "https://brazzers.com",
  network_id: 1298,
};

function fakeFetcher(sites: Record<string, unknown>): Fetcher {
  return {
    json: async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/sites") return { data: [], meta: { total: 0 } };
      const identifier = decodeURIComponent(parsed.pathname.replace("/sites/", ""));
      const site = sites[identifier];
      if (site === undefined) throw new FetchError(`GET ${url} -> 404`, "definitive", 404);
      return { data: site };
    },
  } as unknown as Fetcher;
}

test("a site_id-only address resolves, because the id is exact by construction", async () => {
  // No `site=`, no `name=`, no --name. The name gate rejected every non-uuid
  // result, so an exact id reported UNRESOLVED and fell back to an empty search.
  const lookup = parseTpdbStudioUrl("https://theporndb.net/scenes?site_id=988");
  const fetcher = fakeFetcher({ 988: bangSite });
  const result = await resolveTpdbSite(fetcher, "token", lookup);
  assert.equal(result.outcome, "resolved");
  assert.equal(result.site?.siteId, 988);
  assert.equal(result.site?.resolvedBy, "id");
});

test("a stale site= display hint cannot reject the site the site_id names", async () => {
  // `site=bangbros` used to become the name "Bangbros" and veto site 988, whose
  // real name is "BANG!". The id is the identity; a display slug is not.
  const lookup = parseTpdbStudioUrl("https://theporndb.net/scenes?site=bangbros&site_id=988");
  const fetcher = fakeFetcher({ 988: bangSite });
  const result = await resolveTpdbSite(fetcher, "token", lookup);
  assert.equal(result.outcome, "resolved");
  assert.equal(result.site?.siteId, 988);
});

test("a site_id that cannot be represented exactly is rejected", async () => {
  // Number() would round 9007199254740993 and look up a different site.
  assert.throws(
    () => parseTpdbStudioUrl("https://theporndb.net/scenes?site_id=9007199254740993"),
    /site_id/,
  );
});

test("a multi-word container path is rejected without a site_id", () => {
  // cleanStudioName turns "studios-scenes" into "studios scenes", so the stored
  // entry never matched and the container slipped through to the name search.
  for (const path of ["studios-scenes", "scenes", "studios", "tags"]) {
    assert.throws(() => parseTpdbStudioUrl(`https://theporndb.net/${path}`), /site_id/, path);
  }
});

test("a multi-tag OR search is refused rather than silently turned into an AND", async () => {
  // tag_and=0 with two tags means "Anal or BBC". The declaration's tags are an
  // AND (tpdb-watchlist.ts), so adopting them would change the search's meaning.
  assert.throws(
    () =>
      parseTpdbStudioUrl(
        "https://theporndb.net/scenes?site_id=988&tag_and=0&tags%5B0%5D=Anal&tags%5B1%5D=BBC",
      ),
    /tag_and/,
  );
  // A single tag is unambiguous under either operation.
  assert.deepEqual(
    parseTpdbStudioUrl("https://theporndb.net/scenes?site_id=988&tag_and=0&tags%5B0%5D=Anal").tags,
    ["Anal"],
  );
  // An explicit AND is fine.
  assert.deepEqual(
    parseTpdbStudioUrl(
      "https://theporndb.net/scenes?site_id=988&tag_and=1&tags%5B0%5D=Anal&tags%5B1%5D=BBC",
    ).tags,
    ["Anal", "BBC"],
  );
});

test("an untagged Traxxx lane keeps its own id even when a TPDB search brings tags", () => {
  // The Traxxx tag list must win whenever a lane exists - including when it is
  // empty - or the declaration invents "network-bang-Anal" and files the studio
  // under two different keys.
  const link = buildDeclaration({
    lane: {
      kind: "network",
      slug: "bang",
      tags: [],
      url: "https://traxxx.me/network/bang/scenes/latest/1",
    },
    lookup: parseTpdbStudioUrl("https://theporndb.net/scenes?site_id=988&tags%5B0%5D=Anal"),
    resolved: {
      siteId: 988,
      uuid: undefined,
      name: "BANG!",
      shortName: "bang",
      url: undefined,
      networkId: undefined,
      resolvedBy: "id",
    },
    studioName: "Bang",
  });
  assert.equal(link.studioId, "network-bang");
  assert.equal(link.tags, undefined);
});

test("a TPDB-only lane's id distinguishes its tag scope", () => {
  // Both variants produced "tpdb-bang", so auditStudioLinks rejected a file
  // holding both and --write silently overwrote one with the other. The tagged
  // and untagged lanes are genuinely different lanes.
  const untagged = buildDeclaration({
    lookup: parseTpdbStudioUrl("https://theporndb.net/scenes?site_id=988"),
    resolved: {
      siteId: 988,
      uuid: undefined,
      name: "BANG!",
      shortName: "bang",
      url: undefined,
      networkId: undefined,
      resolvedBy: "id",
    },
    studioName: "Bang",
  });
  const tagged = buildDeclaration({
    lookup: parseTpdbStudioUrl("https://theporndb.net/scenes?site_id=988&tags%5B0%5D=Anal"),
    resolved: {
      siteId: 988,
      uuid: undefined,
      name: "BANG!",
      shortName: "bang",
      url: undefined,
      networkId: undefined,
      resolvedBy: "id",
    },
    studioName: "Bang",
  });
  assert.notEqual(untagged.studioId, tagged.studioId);
  assert.equal(untagged.studioId, "tpdb-bang");
  assert.equal(tagged.studioId, "tpdb-bang-anal");
});

test("a Traxxx-only paste still builds a declaration", () => {
  // The CLI's help says either side may be omitted, and did before this change.
  const link = buildDeclaration({
    lane: {
      kind: "network",
      slug: "brazzers",
      tags: ["anal"],
      url: "https://traxxx.me/network/brazzers/scenes/latest/1?tags=anal",
    },
    lookup: undefined,
    resolved: undefined,
    studioName: "Brazzers",
  });
  assert.equal(link.studioId, "network-brazzers-anal");
  assert.equal(link.tpdb, undefined);
  assert.deepEqual(link.tags, ["anal"]);
});

test("the CLI passes the exact site id through to the resolver", () => {
  // The CLI rebuilt the lookup from `candidates`/`uuid`/`name` only, dropping
  // `exactSiteId`. Verified live before the fix: `?site_id=988` with a
  // non-matching --name reported UNRESOLVED for an id that is exact by
  // construction, and emitted a junk `tpdb-studio` declaration.
  assert.equal(
    lookupForResolver(parseTpdbStudioUrl("https://theporndb.net/scenes?site_id=988")).exactSiteId,
    988,
  );
  assert.equal(
    lookupForResolver(parseTpdbStudioUrl("https://theporndb.net/sites/brazzers"), "Brazzers").name,
    "Brazzers",
  );
});

test("a uuid in the path outranks a site_id in the query", () => {
  // A UUID is the strongest identity available; the id must not silently win
  // over it.
  const uuid = "e3b61b3e-0c20-4bea-9441-b88430ed6317";
  const lookup = parseTpdbStudioUrl(`https://theporndb.net/sites/${uuid}?site_id=988`);
  assert.equal(lookup.uuid, uuid);
  assert.deepEqual(lookup.candidates, [uuid]);
});

test("an explicit --name still verifies a slug-only address", async () => {
  // Regression guard: the id-authoritative path must not weaken the slug check
  // that stops /sites/anything binding the wrong studio.
  // The CLI passes --name through as lookup.name; a slug alone is not enough,
  // which is the check that stops /sites/anything binding the wrong studio.
  const lookup: TpdbLookup = {
    ...parseTpdbStudioUrl("https://theporndb.net/sites/brazzers"),
    name: "Brazzers",
  };
  const fetcher = fakeFetcher({ brazzers });
  assert.equal((await resolveTpdbSite(fetcher, "token", lookup)).outcome, "resolved");
  const wrong = fakeFetcher({ brazzers: { ...brazzers, id: 7 } });
  const mismatched = await resolveTpdbSite(wrong, "token", {
    ...lookup,
    name: "Something Else",
  });
  assert.notEqual(mismatched.site?.siteId, 92);
});
