import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchError } from "../src/core/fetcher.ts";
import type { Fetcher } from "../src/sources/types.ts";
import {
  auditStudioLinks,
  canonicalStudioId,
  cleanStudioName,
  parseTpdbStudioUrl,
  resolveTpdbSite,
  studioAliases,
  studioNameKeys,
  type StudioLink,
} from "../src/sources/studio-identity.ts";

const brazzers = {
  id: 92,
  uuid: "e3b61b3e-0c20-4bea-9441-b88430ed6317",
  name: "Brazzers",
  short_name: "brazzers",
  url: "https://brazzers.com",
  network_id: 1298,
};

type Route = (url: string) => unknown;

/** A fetcher that answers by URL, so each test states only what it cares about. */
function fakeFetcher(route: Route, calls: string[] = []): Fetcher {
  return {
    json: async (url: string) => {
      calls.push(url);
      return route(new URL(url).pathname + new URL(url).search);
    },
  } as unknown as Fetcher;
}

function sitesRoute(sites: Record<string, unknown>, search: Record<string, unknown[]> = {}): Route {
  return (url) => {
    const parsed = new URL(`https://api.theporndb.net${url}`);
    const term = parsed.searchParams.get("q");
    if (term !== null) return { data: search[term] ?? [], meta: { total: 0 } };
    const identifier = decodeURIComponent(parsed.pathname.replace("/sites/", ""));
    const site = sites[identifier];
    if (site === undefined) throw new FetchError(`GET ${url} -> 404`, "definitive", 404);
    return { data: site };
  };
}

test("name cleaning strips accents without collapsing distinct words", () => {
  assert.equal(cleanStudioName("  Bräzzers & Co. "), "brazzers co");
  assert.notEqual(cleanStudioName("Anal Quest"), cleanStudioName("Analquest"));
  assert.deepEqual(studioNameKeys(brazzers), ["brazzers", "brazzers"]);
  assert.deepEqual(studioNameKeys({ name: "Mike Adriano" }), ["mike adriano"]);
});

test("a Traxxx-backed studio keeps its lane id so stored scenes keep their meaning", () => {
  // The lane id is already referenced by stored scenes and source labels, so a
  // declaration must never repoint one. A TPDB-only studio is namespaced so it
  // cannot collide with a lane id either.
  assert.equal(
    canonicalStudioId({ traxxx: { kind: "network", slug: "brazzers" }, tags: ["anal"] }),
    "network-brazzers-anal",
    "the tag is part of the lane id, so it cannot be dropped",
  );
  assert.equal(
    canonicalStudioId({ traxxx: { kind: "network", slug: "brazzers" } }),
    "network-brazzers",
  );
  assert.equal(canonicalStudioId({ tpdb: { shortName: "brazzers" } }), "tpdb-brazzers");
  assert.equal(canonicalStudioId({ tpdb: { name: "Mike Adriano" } }), "tpdb-mike-adriano");
  assert.equal(
    canonicalStudioId({
      traxxx: { kind: "channel", slug: "elegantangel" },
      tpdb: { shortName: "elegantangel" },
    }),
    "channel-elegantangel",
    "the Traxxx side wins, so the two databases share one key",
  );
});

test("pasted URLs are parsed by host and shape, not by argument position", () => {
  const slug = parseTpdbStudioUrl("https://theporndb.net/sites/brazzers");
  assert.deepEqual(slug.candidates, ["brazzers"]);
  const withUuid = parseTpdbStudioUrl(
    "https://theporndb.net/sites/e3b61b3e-0c20-4bea-9441-b88430ed6317/scenes",
  );
  assert.equal(withUuid.uuid, "e3b61b3e-0c20-4bea-9441-b88430ed6317");
  assert.deepEqual(withUuid.candidates, ["e3b61b3e-0c20-4bea-9441-b88430ed6317"]);
  assert.deepEqual(parseTpdbStudioUrl("https://theporndb.net/sites/92").candidates, ["92"]);
  assert.throws(() => parseTpdbStudioUrl("http://theporndb.net/sites/brazzers"), /HTTPS/);
  assert.throws(() => parseTpdbStudioUrl("https://traxxx.me/network/brazzers"), /unsupported host/);
  assert.throws(() => parseTpdbStudioUrl("https://theporndb.net/"), /no studio identifier/);
});

test("a slug resolves to its site when the declared name agrees", async () => {
  const fetcher = fakeFetcher(sitesRoute({ brazzers }));
  const result = await resolveTpdbSite(fetcher, "token", {
    candidates: ["brazzers"],
    name: "Brazzers",
  });
  assert.equal(result.outcome, "resolved");
  assert.equal(result.site?.siteId, 92);
  assert.equal(result.site?.resolvedBy, "slug");
  assert.equal(result.site?.networkId, 1298);
});

test("a uuid is matched exactly, and a name that disagrees is not needed to accept it", async () => {
  const fetcher = fakeFetcher(sitesRoute({ "e3b61b3e-0c20-4bea-9441-b88430ed6317": brazzers }));
  const result = await resolveTpdbSite(fetcher, "token", {
    candidates: ["e3b61b3e-0c20-4bea-9441-b88430ed6317"],
    uuid: "e3b61b3e-0c20-4bea-9441-b88430ed6317",
    name: "Anything At All",
  });
  assert.equal(result.outcome, "resolved");
  assert.equal(result.site?.siteId, 92, "a uuid outranks the display name");
});

test("a loose slug returning a different studio is rejected, not trusted", async () => {
  // /sites/{identifier} resolves loosely. Binding the response unchecked would
  // file another studio's releases under this studio's name.
  const fetcher = fakeFetcher(sitesRoute({ brazzers }));
  const result = await resolveTpdbSite(fetcher, "token", {
    candidates: ["brazzers"],
    name: "Mike Adriano",
  });
  assert.equal(result.outcome, "absent");
  assert.equal(result.site, undefined);
});

test("an absent studio is reported with the candidates TPDB does have", async () => {
  const fetcher = fakeFetcher(
    sitesRoute(
      {},
      {
        // TPDB's search is case-insensitive, so the raw declared name is what
        // is sent; the fake keys on exactly what the resolver passes.
        "Mike Adriano": [
          { id: 72432, name: "HobbyPorn: Mike Adriano", short_name: "hobbypornmikeadriano" },
          {
            id: 39863,
            name: "FansDB: Realmikeadriano (onlyfans)",
            short_name: "fansdbrealmikeadrianoonlyfans",
          },
        ],
      },
    ),
  );
  const result = await resolveTpdbSite(fetcher, "token", {
    candidates: ["mike adriano"],
    name: "Mike Adriano",
  });
  assert.equal(result.outcome, "absent");
  assert.deepEqual(
    result.candidates.map((candidate) => candidate.id),
    [72432, 39863],
    "the report names what TPDB has, so the operator can pick deliberately",
  );
});

test("an exactly-named search result is accepted when the direct lookup missed", async () => {
  const fetcher = fakeFetcher(
    sitesRoute({}, { Vixen: [{ id: 3372, name: "Vixen", short_name: "vixen" }] }),
  );
  const result = await resolveTpdbSite(fetcher, "token", { candidates: ["vixen"], name: "Vixen" });
  assert.equal(result.outcome, "resolved");
  assert.equal(result.site?.siteId, 3372);
  assert.equal(result.site?.resolvedBy, "search");
});

test("a name matching several TPDB sites is ambiguous and binds nothing", async () => {
  const fetcher = fakeFetcher(
    sitesRoute(
      {},
      {
        Brazzers: [
          { id: 92, name: "Brazzers", short_name: "brazzers" },
          { id: 32172, name: "BRAZZERSS", short_name: "brazzerss" },
        ],
      },
    ),
  );
  const result = await resolveTpdbSite(fetcher, "token", {
    candidates: ["brazzers"],
    name: "Brazzers",
  });
  // Brazzers matches exactly one of the two; the near-match is not bound.
  assert.equal(result.outcome, "resolved");
  assert.equal(result.site?.siteId, 92);

  const both = fakeFetcher(
    sitesRoute(
      {},
      {
        Brazzers: [
          { id: 92, name: "Brazzers", short_name: "brazzers" },
          { id: 200, name: "brazzers", short_name: "brazzers" },
        ],
      },
    ),
  );
  const ambiguous = await resolveTpdbSite(both, "token", { candidates: ["x"], name: "Brazzers" });
  assert.equal(ambiguous.outcome, "ambiguous");
  assert.equal(ambiguous.site, undefined);
});

test("a transport failure propagates instead of reading as an absent studio", async () => {
  // Swallowing this would report the lane as working while silently dropping
  // every studio that happened to fail.
  const calls: string[] = [];
  const fetcher = fakeFetcher((url) => {
    if (url.includes("q=")) return { data: [], meta: { total: 0 } };
    throw new FetchError(`GET ${url} -> 503`, "inconclusive", 503);
  }, calls);
  await assert.rejects(
    resolveTpdbSite(fetcher, "token", { candidates: ["brazzers"], name: "Brazzers" }),
    /503/,
  );
  assert.equal(
    calls.some((url) => url.includes("q=")),
    false,
    "an unanswerable search is not evidence of absence, so no candidates are invented",
  );
});

test("a search that does not answer after a clean miss still reports absent", async () => {
  const fetcher = fakeFetcher((url) => {
    if (url.includes("q=")) throw new FetchError(`GET ${url} -> 503`, "inconclusive", 503);
    throw new FetchError(`GET ${url} -> 404`, "definitive", 404);
  });
  const result = await resolveTpdbSite(fetcher, "token", { candidates: ["nope"], name: "Nope" });
  assert.equal(result.outcome, "absent");
  assert.deepEqual(result.candidates, []);
});

test("aliases are the cleaned spellings a TPDB response may match", () => {
  const link: StudioLink = {
    studioId: "network-mikeadriano",
    studio: "Mike Adriano",
    aliases: ["mikeadriano", "MikeAdriano"],
  };
  assert.deepEqual(studioAliases(link), ["mike adriano", "mikeadriano"]);
  assert.deepEqual(studioAliases({ studioId: "a", studio: "A" }), ["a"]);
});

test("two studios claiming one alias are reported, because neither would resolve", () => {
  // The TPDB lane maps a doubly-claimed alias to null rather than guessing, so
  // this is SAFE at runtime - but silently: both studios just report unmatched,
  // which reads exactly like TPDB not carrying them. Naming the conflict is the
  // difference between a visible mistake and a lane that quietly stops working.
  const problems = auditStudioLinks([
    { studioId: "network-brazzers", studio: "Brazzers", tpdb: { siteIds: [92], name: "Brazzers" } },
    {
      studioId: "channel-brazzers-exxtra",
      studio: "Brazzers Exxtra",
      aliases: ["Brazzers"],
      tpdb: { siteIds: [116], name: "Brazzers Exxtra" },
    },
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /alias "brazzers" is claimed by/);
  assert.match(problems[0]!, /channel-brazzers-exxtra/);
  assert.match(problems[0]!, /network-brazzers/);
  assert.match(problems[0]!, /neither would resolve/);
});

test("one studio repeating its own alias is not a conflict", () => {
  assert.deepEqual(
    auditStudioLinks([
      {
        studioId: "network-brazzers",
        studio: "Brazzers",
        aliases: ["Brazzers", "BRAZZERS", "brazzers"],
        tpdb: { siteIds: [92], name: "Brazzers" },
      },
    ]),
    [],
    "a studio claiming the same name several ways is normal, not a collision",
  );
});

test("two studios claiming one key or one TPDB site are reported as conflicts", () => {
  const links: StudioLink[] = [
    { studioId: "network-brazzers", studio: "Brazzers", tpdb: { siteIds: [92], name: "Brazzers" } },
    {
      studioId: "network-brazzers-2",
      studio: "Brazzers Vault",
      tpdb: { siteIds: [92], name: "Brazzers Vault" },
    },
    { studioId: "channel-x", studio: "X", aliases: ["X"], tpdb: { siteIds: [7], name: "X" } },
    {
      studioId: "channel-x-2",
      studio: "X two",
      aliases: ["X"],
      tpdb: { siteIds: [7], name: "X2" },
    },
  ];
  const problems = auditStudioLinks(links);
  // Three distinct problems: the shared TPDB site 92, the shared TPDB site 7, and
  // the shared alias "x" declared on both X lanes.
  assert.equal(problems.length, 3);
  assert.ok(problems.some((problem) => problem.includes("TPDB site 92")));
  assert.ok(problems.some((problem) => problem.includes("channel-x")));
  assert.ok(problems.some((problem) => problem.includes('alias "x" is claimed by')));
  assert.deepEqual(
    auditStudioLinks([
      {
        studioId: "network-brazzers",
        studio: "Brazzers",
        tpdb: { siteIds: [92], name: "Brazzers" },
      },
      {
        studioId: "channel-brazzers-vault",
        studio: "Brazzers Vault",
        tpdb: { siteIds: [116], name: "Brazzers Vault" },
      },
    ]),
    [],
    "distinct studios on distinct TPDB sites are fine",
  );
});
