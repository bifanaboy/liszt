/**
 * The sxyprn rung, asserted at the search boundary.
 *
 * MEASURED 2026-10-10 against the live site, and these are the properties the
 * rung's correctness rests on - each one is a way the rung can be silently
 * dead rather than loudly wrong:
 *
 *  - the search URL is the single-slug form `https://sxyprn.com/<slug>.html`,
 *    because a multi-token query is IGNORED by the site past its first token.
 *  - the title lives in the anchor's `title=` attribute, not the text body.
 *  - the duration is the rendered `MM:SS` / `HH:MM:SS` clock on the card; a
 *    card with no readable clock is DROPPED, never guessed.
 *  - views are rendered as `1,234 views` and normalised to a number.
 *  - the lookup filters on duration and ranks on identity, with no date gate -
 *    cards carry no structured date.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSxyprnSearch,
  createSxyprnLookup,
  parseSxyprnDuration,
  sxyprnSlug,
} from "../src/tubes/sxyprn.ts";
import type { Fetcher } from "../src/sources/types.ts";
import { makeMatchScene } from "./helpers.ts";

/** A trimmed card block, in the shape sxyprn renders (single-quoted attrs). */
function card(id: string, title: string, duration: string, views = "1,234"): string {
  return (
    `<div class="post_el_small">` +
    `<a class="post_time" href='/post/${id}.html' ` +
    `title='${title}'>thumb</a>` +
    `<div class="post_dur">${duration}</div>` +
    `<div class="post_views">${views} views</div>` +
    `</div>`
  );
}

function fetcherFor(html: string): Fetcher {
  return {
    text: async (url: string) => {
      if (!/^https:\/\/sxyprn\.com\/[a-z0-9-]+\.html$/.test(url))
        throw new Error(`unexpected url ${url}`);
      return html;
    },
    json: async () => {
      throw new Error("sxyprn search must not use the JSON path");
    },
  } as unknown as Fetcher;
}

test("parseSxyprnDuration reads MM:SS and HH:MM:SS, and nothing else", () => {
  assert.equal(parseSxyprnDuration("39:53"), 2393);
  assert.equal(parseSxyprnDuration("1:14:19"), 4459);
  assert.equal(parseSxyprnDuration("0:00"), null);
  assert.equal(parseSxyprnDuration("not a clock"), null);
  assert.equal(parseSxyprnDuration(""), null);
});

test("sxyprnSlug collapses to the site's slug convention", () => {
  assert.equal(sxyprnSlug("Emma Rosie"), "emma-rosie");
  assert.equal(sxyprnSlug("  Jules  Jordan! "), "jules-jordan");
});

test("search returns candidates in the production candidate shape", async () => {
  const html =
    card("6ac8e52565fca", "JulesJordan Emma Rosie Is A Teen Cumslut", "39:53") +
    card("6ac95cd88a347", "ExploitedCollegeGirls Emma aka Emma Rosie", "49:27", "8,901");
  const search = createSxyprnSearch(fetcherFor(html));
  const results = await search("emma-rosie");

  assert.equal(results.length, 2);
  assert.equal(results[0]!.url, "https://sxyprn.com/post/6ac8e52565fca.html");
  assert.equal(results[0]!.title, "JulesJordan Emma Rosie Is A Teen Cumslut");
  assert.equal(results[0]!.duration, 2393, "39:53 -> 2393 seconds");
  assert.equal(results[0]!.views, 1234);
  assert.equal(results[1]!.duration, 2967, "49:27 -> 2967 seconds");
  assert.equal(results[1]!.views, 8901);
});

test("a card with no readable duration is dropped, not guessed", async () => {
  const html =
    card("6ac8e52565fca", "Emma Rosie Something", "39:53") +
    `<div class="post_el_small"><a class="post_time" href='/post/6ac9424ca2409.html' title='No Duration Here'></a></div>`;
  const search = createSxyprnSearch(fetcherFor(html));
  const results = await search("emma-rosie");
  assert.equal(results.length, 1);
  assert.equal(results[0]!.url, "https://sxyprn.com/post/6ac8e52565fca.html");
});

test("the search URL is the slug form and the query is slugified", async () => {
  const seen: string[] = [];
  const fetcher = {
    text: async (url: string) => {
      seen.push(url);
      return "";
    },
  } as unknown as Fetcher;
  const search = createSxyprnSearch(fetcher);
  await search("Emma Rosie");
  assert.deepEqual(seen, ["https://sxyprn.com/emma-rosie.html"]);
});

const SCENE = makeMatchScene({
  id: "test:1",
  title: "Emma Rosie takes it deep",
  performers: ["Emma Rosie"],
  releaseDate: "2026-03-04",
  durationSec: 2393,
});

test("the lookup filters on duration and ranks on identity", async () => {
  const html =
    card("6ac8e52565fca", "Emma Rosie takes it deep", "39:53") +
    card("6ac95cd88a347", "Some other studio scene", "39:54") +
    card("6ac9424ca2409", "Another duration miss", "12:00");
  const lookup = createSxyprnLookup(createSxyprnSearch(fetcherFor(html)), {
    durationToleranceSec: 1,
  });
  const matches = await lookup(SCENE);
  assert.equal(matches.length, 2, "two duration survivors, the 12:00 card is filtered out");
  assert.equal(matches[0]!.url, "https://sxyprn.com/post/6ac8e52565fca.html");
  assert.equal(matches[0]!.identityTier, 3, "the scene title appears verbatim in the card title");
  assert.equal(matches[1]!.identityTier, 0, "unnamed survivor is kept for the fallback");
  assert.equal(matches[0]!.views, 1234, "views travel with the survivor for the fallback");
  assert.equal(matches[0]!.title, "Emma Rosie takes it deep");
});

test("a search that cannot answer is an outage, not a no-match", async () => {
  const fetcher = {
    text: async () => {
      throw new Error("403 from the edge");
    },
  } as unknown as Fetcher;
  const lookup = createSxyprnLookup(createSxyprnSearch(fetcher), {});
  await assert.rejects(lookup(SCENE), /sxyprn search unavailable: 403 from the edge/);
});
