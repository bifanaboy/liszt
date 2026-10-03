/**
 * Woodman Casting X without the studio's XXXX scenes (#82).
 *
 * The exclusion has to be narrow in both directions: an XXXX scene must not
 * reach the catalogue, and the channel's unmarked titles that merely contain the
 * letter x - "Shania VegaX casting", "Lexxxus Adams casting", "Area X69" - must
 * stay. The captured page below is a trimmed copy of the real traxxx response
 * for `e=woodmancastingx`, taken 2026-10-03: four XXXX-marked titles, four
 * "casting" titles, and one foreign channel record that leaked into the page.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { loadConfig } from "../src/config.ts";
import { createSources } from "../src/sources/registry.ts";
import { createSync } from "../src/pipeline/sync.ts";
import { NullLogger } from "../src/core/logger.ts";
import { fixedClock, type SourceContext } from "../src/sources/types.ts";
import {
  createWoodmanCastingXSource,
  isXxxxMarkedTitle,
  WOODMAN_CASTING_X_ID,
  WOODMAN_CASTING_X_SLUG,
} from "../src/sources/woodman-casting-x.ts";

const page = JSON.parse(
  readFileSync(new URL("./fixtures/woodman-casting-x-page.json", import.meta.url), "utf8"),
);
const NOW = "2026-10-03T00:00:00Z";
const WINDOW_START = "2026-07-05";
const INDEX_TOTAL = 528_792;

function setup(respond: (url: URL) => unknown) {
  const calls: string[] = [];
  const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
  const ctx: SourceContext = {
    now: new Date(NOW),
    log(message, fields = {}) {
      logs.push({ message, fields });
    },
    mapWithConcurrency: async (items, task) => Promise.all(items.map(task)),
    mapIsolated: async (items, task) => Promise.all(items.map(task)),
    traxxx: { minIntervalMs: 0 },
    fetcher: {
      async fetch(url: string) {
        calls.push(url);
        return Response.json(respond(new URL(url)));
      },
      async text() {
        throw new Error("unexpected text");
      },
      async json<T>(): Promise<T> {
        throw new Error("unexpected json");
      },
    },
  };
  return { ctx, calls, logs };
}

/** The unfiltered baseline request carries no `e`; the lane's own page does. */
const channelPage =
  (scenes: unknown[]) =>
  (url: URL): unknown => {
    if (!url.searchParams.has("e")) return { scenes: [], total: INDEX_TOTAL, limit: 1 };
    return { ...page, total: 2071, limit: 100, scenes };
  };

test("the registry runs the lane by default and it is an ordinary traxxx channel", () => {
  const source = createSources(loadConfig({})).find((s) => s.id === WOODMAN_CASTING_X_ID);
  assert.ok(source, "Woodman Casting X must be registered by default");
  assert.equal(source.name, "Woodman Casting X");
  assert.equal(source.matcher, "sxyprn+eporner");
  assert.equal(source.authority.url, `https://traxxx.me/api/scenes?e=${WOODMAN_CASTING_X_SLUG}`);
});

test("the marker is a whole token, so unmarked titles that contain the letter x survive", () => {
  for (const title of [
    "Mery Colt - XXXX - A DP was not enough, I tried DVP too",
    "Sarah Cute - XXXX ) CPX # 20",
    "Lily White - XXXX - Area X69 # 73",
    "Sweet Cherry - XXXX - I wanted them to destroy my ass",
  ]) {
    assert.equal(isXxxxMarkedTitle(title), true, title);
  }
  for (const title of [
    "Mery Colt casting",
    "Shania VegaX casting",
    "Lexxxus Adams casting",
    "Xenia Blondi casting",
    "Karina Muller - BTS - Fucked in DP front of the fire",
    "Mery Colt on Woodman casting X",
  ]) {
    assert.equal(isXxxxMarkedTitle(title), false, title);
  }
  assert.equal(isXxxxMarkedTitle(undefined), false);
  assert.equal(isXxxxMarkedTitle(null), false);
  assert.equal(isXxxxMarkedTitle(""), false);
});

test("the captured channel page yields only its unmarked scenes", async () => {
  const { ctx, logs } = setup(channelPage(page.scenes));
  const result = await createWoodmanCastingXSource().fetch(WINDOW_START, ctx);
  assert.deepEqual(
    result.scenes.map((scene) => scene.sourceSceneId),
    ["725778", "725192", "724952", "723617"],
  );
  assert.ok(
    result.scenes.every((scene) => !isXxxxMarkedTitle(scene.title)),
    "no XXXX scene may reach the catalogue",
  );
  assert.equal(result.verifiedEmpty, false);
  assert.deepEqual(logs.find((entry) => entry.message === "traxxx: lane complete")?.fields, {
    records: 9,
    emitted: 4,
    filtered: 5,
    excluded: 4,
  });
});

test("a kept scene keeps the studio's own record, performer, duration and provenance", async () => {
  const { ctx } = setup(channelPage(page.scenes));
  const [scene] = (await createWoodmanCastingXSource().fetch(WINDOW_START, ctx)).scenes;
  assert.equal(scene!.title, "Mery Colt casting");
  assert.equal(scene!.releaseDate, "2026-09-25");
  assert.equal(scene!.durationSec, 1680);
  assert.deepEqual(scene!.performers, ["Mery Colt"]);
  assert.equal(scene!.releaseUrl, page.scenes[1].url);
  assert.equal(scene!.provenance?.source, "traxxx.me");
  assert.equal(scene!.source, "traxxx.me");
});

test("x look-alikes survive a whole fetch, not just the marker function", async () => {
  const lookalikes = [
    { id: 318398, title: "Shania VegaX casting", date: "2026-09-20T00:00:00Z", duration: 3360 },
    { id: 318257, title: "Lexxxus Adams casting", date: "2026-09-19T00:00:00Z", duration: 1380 },
    { id: 318200, title: "Xenia Blondi casting", date: "2026-09-18T00:00:00Z", duration: 900 },
  ].map((record) => ({
    ...record,
    channel: { slug: WOODMAN_CASTING_X_SLUG, name: "Woodman Casting X" },
    actors: [{ name: "Someone", gender: null }],
  }));
  const { ctx, logs } = setup(channelPage(lookalikes));
  const result = await createWoodmanCastingXSource().fetch(WINDOW_START, ctx);
  assert.deepEqual(
    result.scenes.map((scene) => scene.sourceSceneId),
    ["318398", "318257", "318200"],
  );
  assert.equal(logs.find((entry) => entry.message === "traxxx: lane complete")?.fields.excluded, 0);
});

test("a window whose every scene is marked is a verified empty, not a silent failure", async () => {
  const marked = page.scenes.filter(
    (record: { title: string; channel: { slug: string } }) =>
      record.channel.slug === WOODMAN_CASTING_X_SLUG && /XXXX/.test(record.title),
  );
  assert.equal(marked.length, 4);
  const { ctx } = setup(channelPage(marked));
  const result = await createWoodmanCastingXSource().fetch(WINDOW_START, ctx);
  assert.deepEqual(result.scenes, []);
  assert.equal(result.verifiedEmpty, true);
});

test("the traxxx filter guard still holds for this lane", async () => {
  const { ctx } = setup(() => ({ scenes: [], total: INDEX_TOTAL, limit: 1 }));
  await assert.rejects(
    () => createWoodmanCastingXSource().fetch(WINDOW_START, ctx),
    /matched nothing/,
  );
});

for (const dateField of ["date", "effectiveDate"] as const) {
  test(`a full page of excluded old records stops pagination using ${dateField}`, async () => {
    const scenes = Array.from({ length: 100 }, (_, id) => ({
      id,
      title: "XXXX",
      [dateField]: "!Date:2026-07-04T00:00:00Z",
      channel: { slug: WOODMAN_CASTING_X_SLUG },
    }));
    const { ctx, calls, logs } = setup((url) => {
      if (url.searchParams.has("e") && url.searchParams.get("page") !== "1") {
        return { scenes: [], total: 2071, limit: 100 };
      }
      return channelPage(scenes)(url);
    });
    const result = await createWoodmanCastingXSource().fetch(WINDOW_START, ctx);
    assert.deepEqual(result.scenes, []);
    assert.equal(result.verifiedEmpty, true);
    assert.deepEqual(
      calls
        .map((url) => new URL(url))
        .filter((url) => url.searchParams.has("e"))
        .map((url) => url.searchParams.get("page")),
      ["1"],
    );
    assert.deepEqual(logs.find((entry) => entry.message === "traxxx: lane complete")?.fields, {
      records: 100,
      emitted: 0,
      filtered: 100,
      excluded: 100,
    });
  });
}

test("a source failure keeps the last-good records instead of erasing the lane", async () => {
  const store = new SqliteStore(":memory:");
  store.migrate();
  let broken = false;
  const ctx: SourceContext = {
    now: new Date(NOW),
    log: () => {},
    mapWithConcurrency: async (items, task) => Promise.all(items.map(task)),
    mapIsolated: async (items, task) => Promise.all(items.map(task)),
    traxxx: { minIntervalMs: 0 },
    fetcher: {
      fetch: async (url: string) => {
        if (broken) throw new Error("upstream 503");
        return Response.json(channelPage(page.scenes)(new URL(url)));
      },
      text: async () => "",
      json: async <T>(): Promise<T> => {
        throw new Error("unexpected json");
      },
    },
  };
  try {
    const run = createSync({
      store,
      sources: [createWoodmanCastingXSource()],
      fetcher: ctx.fetcher,
      clock: fixedClock(NOW),
      log: new NullLogger(),
      windowDays: 90,
      fetchConcurrency: 1,
      lookups: { poolLookup: null, sxyprnLookup: null },
      resolveEnabled: false,
    });
    assert.equal((await run("first")).ok, true);
    broken = true;
    const failed = await run("broken");
    assert.equal(failed.ok, false);
    assert.match(failed.outcomes[0]?.error ?? "", /upstream 503/);
    assert.equal(store.listWindow(WINDOW_START, NOW.slice(0, 10)).length, 4);
  } finally {
    store.close();
  }
});
