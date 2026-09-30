/**
 * The shared direct-scrape adapter, asserted at the two boundaries it owns: the
 * per-source concurrency contract, and the failure isolation that keeps one bad
 * video page from discarding an entire lane's scenes.
 *
 * The adapter's own fan-out runs INSIDE the cycle's per-source fan-out, so it
 * must not draw from the shared fetch pool - that pool is one counter and is not
 * re-entrant. The regression test below saturates the outer pool deliberately:
 * without `mapIsolated` on the context, every inner acquire waits for a release
 * that only the inner pass could make.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectScrapeStudio, type ListingEntry } from "../src/sources/direct-scrape.ts";
import { mapIsolated, mapWithConcurrency } from "../src/core/concurrency.ts";
import { withDeadline } from "./helpers.ts";
import type { Fetcher, SourceContext } from "../src/sources/types.ts";

const BASE = "https://studio.test";
const NOW = new Date("2026-03-10T00:00:00Z");
const WINDOW_START = "2026-01-10";

/** Entries are `/scene/<id>`; each page hydrates to its own dated scene. */
function parseListing(html: string, base: string): ListingEntry[] {
  return [...html.matchAll(/href="(\/scene\/[a-z0-9]+)"/g)].map(([, path]) => ({
    releaseUrl: `${base}${path}`,
  }));
}

function parseVideoPage(_html: string, entry: ListingEntry, base: string) {
  return {
    sourceSceneId: new URL(entry.releaseUrl).pathname,
    title: "Scene",
    releaseDate: "2026-03-05",
    performers: [],
    durationSec: 600,
    source: "studio",
    provenance: { source: base },
  };
}

const IDS = ["a", "b", "c", "d"];

/** Serves the listing plus one dated page per entry; `fail` names a 500 URL. */
function studioFetcher(fail?: string): Fetcher {
  const respond = (url: string): Response => {
    if (fail && url.endsWith(fail)) return new Response("boom", { status: 500 });
    const body = url.includes("/scene/")
      ? "<html><body>ok</body></html>"
      : `<html><body>${IDS.map((id) => `<a href="/scene/${id}">Scene</a>`).join("")}</body></html>`;
    return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
  };
  return {
    fetch: async (url: string) => respond(url),
    text: async (url: string) => respond(url).text(),
    json: async <T>() => ({}) as T,
  };
}

/**
 * The real wiring, verbatim from `sync.ts`: the per-source fan-out and the
 * adapter's own fan-out are the shared pool and `mapIsolated` respectively. If
 * the adapter ever reached for `mapWithConcurrency` again, this context would
 * hand it the deadlocking one.
 */
function context(concurrency: number, fetcher: Fetcher = studioFetcher()): SourceContext {
  return {
    fetcher,
    now: NOW,
    log: () => {},
    mapWithConcurrency: <T, R>(items: T[], task: (item: T, index: number) => Promise<R>) =>
      mapWithConcurrency(items, task, concurrency),
    mapIsolated: <T, R>(items: T[], task: (item: T, index: number) => Promise<R>) =>
      mapIsolated(items, task, concurrency),
  };
}

function studio(ctx: SourceContext) {
  const adapter = createDirectScrapeStudio({
    id: "studio",
    name: "Studio",
    allowedHosts: ["studio.test"],
    listingUrl: `${BASE}/listing`,
    windowDays: 90,
    matcher: "sxyprn+eporner",
    parseListing,
    parseVideoPage,
  });
  return adapter.fetch(WINDOW_START, ctx);
}

test("listing hydration inside the per-source fan-out does not deadlock the shared pool", async () => {
  // Four sources over a pool of four, so all four slots are held for the whole
  // of each adapter's run - which is exactly the saturation a re-entrant acquire
  // cannot survive. Deterministic, not a timing gamble.
  const adapters = ["one", "two", "three", "four"].map((id) => ({ id }));
  const results = await withDeadline(
    mapWithConcurrency(adapters, () => studio(context(4)), 4),
    5_000,
    "direct-scrape hydration deadlocked the shared fetch pool",
  );
  assert.equal(results.length, 4);
  for (const [index, result] of results.entries()) {
    assert.equal(
      result.scenes.length,
      4,
      `source ${index} hydrated every page rather than deadlocking`,
    );
  }
});

test("one failed video page keeps the rest of the lane's scenes", async () => {
  // `mapIsolated` rejects the whole call the moment a task rejects, so failures
  // are collected per entry instead. Before that, a single 500 discarded every
  // record the other N-1 pages had already produced.
  const ctx = context(2, studioFetcher("/scene/b"));
  const result = await studio(ctx);
  assert.deepEqual(result.scenes.map((scene) => scene.sourceSceneId).sort(), [
    "/scene/a",
    "/scene/c",
    "/scene/d",
  ]);
  assert.equal(result.verifiedEmpty, false, "a lane that lost records must not claim it is empty");
});

test("an empty queue is only trusted when the listing itself carried entries", async () => {
  // `verifiedEmpty: true` tells sync to delete the lane's catalogue. That is only
  // evidence when the listing was READABLE, so a listing that parsed to nothing
  // must not be able to trigger it.
  const ctx = context(2, {
    fetch: async () => new Response("<html><body>nothing here</body></html>", { status: 200 }),
    text: async () => "<html><body>nothing here</body></html>",
    json: async <T>() => ({}) as T,
  });
  const result = await studio(ctx);
  assert.deepEqual(result.scenes, []);
  assert.equal(result.verifiedEmpty, false);
});
