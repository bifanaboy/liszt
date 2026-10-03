import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { loadConfig } from "../src/config.ts";
import { createSources } from "../src/sources/registry.ts";
import { normaliseScene, createSync } from "../src/pipeline/sync.ts";
import { NullLogger } from "../src/core/logger.ts";
import { fixedClock, type SourceContext } from "../src/sources/types.ts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/manyvids-store.json", import.meta.url), "utf8"),
);
const video = fixture.data[0];
const page = (data: unknown[], currentPage = 1, nextPage: number | null = null) => ({
  data,
  pagination: { total: data.length, totalPages: nextPage ?? currentPage, currentPage, nextPage },
});
function setup(respond: (url: URL) => unknown, store = new SqliteStore(":memory:")) {
  store.migrate();
  const calls: string[] = [];
  const config = loadConfig({ LISZT_MANYVIDS_MIN_INTERVAL_MS: "0" });
  const adapter = createSources({ ...config, store }).find(
    (source) => source.id === "manyvids-1003095958",
  );
  assert.ok(adapter, "ManyVids must be registered by default");
  const ctx: SourceContext = {
    now: new Date("2026-10-03T00:00:00Z"),
    log() {},
    mapWithConcurrency: async (items, fn) => Promise.all(items.map(fn)),
    mapIsolated: async (items, fn) => Promise.all(items.map(fn)),
    fetcher: {
      async json<T>(url: string): Promise<T> {
        calls.push(url);
        return respond(new URL(url)) as T;
      },
      async fetch() {
        throw new Error("unexpected fetch");
      },
      async text() {
        throw new Error("unexpected text");
      },
    },
  };
  return { store, adapter, ctx, calls };
}

test("ManyVids store configuration defaults to Maximo and accepts explicit empty or collaborator lists", () => {
  assert.deepEqual(loadConfig({}).manyvidsStoreIds, ["1003095958"]);
  assert.deepEqual(loadConfig({ LISZT_MANYVIDS_STORE_IDS: "" }).manyvidsStoreIds, []);
  assert.deepEqual(
    loadConfig({ LISZT_MANYVIDS_STORE_IDS: "1003095958,1008105753,1003095958" }).manyvidsStoreIds,
    ["1003095958", "1008105753"],
  );
  assert.throws(() => loadConfig({ LISZT_MANYVIDS_STORE_IDS: "bad/id" }), /manyvidsStoreIds/);
});

test("ManyVids imports captured metadata and round-trips through SQLite", async () => {
  const { store, adapter, ctx } = setup(() => ({
    ...fixture,
    pagination: { ...fixture.pagination, total: 9, totalPages: 1, nextPage: null },
  }));
  try {
    const result = await adapter.fetch("2026-07-01", ctx);
    assert.equal(result.scenes.length, 9);
    const raw = result.scenes[0]!;
    const scene = normaliseScene(adapter, raw, ctx.now);
    store.upsertScene(scene);
    const saved = store.getScene(scene.id)!;
    assert.equal(saved.durationSec, 2171);
    assert.equal(saved.releaseDate, "2026-10-02");
    assert.equal(saved.launchDate, video.launchDate);
    assert.deepEqual(saved.price, video.price);
    assert.equal(saved.previewUrl, video.preview.url);
    assert.equal(saved.storeId, "1003095958");
    assert.equal(saved.thumbnailUrl, video.thumbnail.url);
    assert.deepEqual(saved.performers, [], "a store owner is not necessarily a performer");
    assert.equal(saved.videoUrls.length, 0, "a preview is not a playback link");
    assert.match(saved.releaseUrl!, /\/Video\/7871546\//);
  } finally {
    store.close();
  }
});

test("first and weekly pulls walk past old dates; incremental pulls stop on known ids and survive adapter restart", async () => {
  let phase = "first";
  const { store, adapter, ctx, calls } = setup((url) => {
    const n = Number(url.searchParams.get("page"));
    if (n === 1) return page([video], 1, 2);
    if (n === 2) return page([{ ...video, id: "2", launchDate: "2020-01-01T00:00:00Z" }], 2, 3);
    assert.equal(phase === "first" || phase === "weekly", true);
    return page([{ ...video, id: "3" }], 3);
  });
  try {
    assert.equal((await adapter.fetch("2026-07-01", ctx)).scenes.length, 2);
    assert.equal(calls.length, 3);
    phase = "incremental";
    const restarted = createSources({
      ...loadConfig({ LISZT_MANYVIDS_MIN_INTERVAL_MS: "0" }),
      store,
    }).find((s) => s.id === adapter.id)!;
    ctx.now = new Date("2026-10-04T00:00:00Z");
    assert.equal((await restarted.fetch("2026-07-01", ctx)).scenes.length, 2);
    assert.equal(calls.length, 4);
    phase = "weekly";
    ctx.now = new Date("2026-10-10T00:00:00Z");
    await restarted.fetch("2026-07-01", ctx);
    assert.equal(calls.length, 7);
    assert.ok(calls.every((url) => !new URL(url).searchParams.has("tag")));
  } finally {
    store.close();
  }
});

test("partial failure does not save known ids or advance the full-pull checkpoint", async () => {
  let fail = true;
  const { store, adapter, ctx, calls } = setup((url) => {
    if (url.searchParams.get("page") === "1") return page([video], 1, 2);
    if (fail) throw new Error("upstream 503");
    return page([{ ...video, id: "2" }], 2);
  });
  try {
    await assert.rejects(adapter.fetch("2026-07-01", ctx), /upstream 503/);
    fail = false;
    assert.equal((await adapter.fetch("2026-07-01", ctx)).scenes.length, 2);
    assert.equal(calls.length, 4);
  } finally {
    store.close();
  }
});

for (const [name, body] of [
  ["missing pagination", { data: [] }],
  ["looping page", page([video], 1, 1)],
  ["invalid date", page([{ ...video, launchDate: "not a date" }])],
  ["impossible date", page([{ ...video, launchDate: "2026-02-30T00:00:00Z" }])],
  ["invalid runtime", page([{ ...video, duration: "49:99" }])],
  ["wrong store", page([{ ...video, creator: { ...video.creator, id: "9" } }])],
  ["empty nonterminal page", page([], 1, 2)],
] as const) {
  test(`ManyVids fails loudly for ${name}`, async () => {
    const { store, adapter, ctx } = setup(() => body);
    try {
      await assert.rejects(adapter.fetch("2026-07-01", ctx));
    } finally {
      store.close();
    }
  });
}

test("a verified empty store is successful and keeps last-good watchlist records", async () => {
  let empty = false;
  const { store, adapter, ctx } = setup(() =>
    empty
      ? { data: [], pagination: { total: 0, totalPages: 0, currentPage: 1, nextPage: null } }
      : page([video]),
  );
  try {
    const run = createSync({
      store,
      sources: [adapter],
      fetcher: ctx.fetcher,
      clock: fixedClock(ctx.now.toISOString()),
      log: new NullLogger(),
      windowDays: 90,
      fetchConcurrency: 1,
      lookups: { poolLookup: null, sxyprnLookup: null },
      resolveEnabled: false,
    });
    assert.equal((await run("first")).ok, true);
    empty = true;
    assert.equal((await run("empty")).ok, true);
    assert.equal(store.listWindow("2026-07-01", "2026-10-03").length, 1);
  } finally {
    store.close();
  }
});

test("captured final-page response omits nextPage and terminates the full walk", async () => {
  const last = JSON.parse(
    readFileSync(new URL("./fixtures/manyvids-last-page.json", import.meta.url), "utf8"),
  );
  const { store, adapter, ctx, calls } = setup((url) => {
    const current = Number(url.searchParams.get("page"));
    return current === 64 ? last : page([video], current, current + 1);
  });
  try {
    await adapter.fetch("2026-07-01", ctx);
    assert.equal(calls.length, 64);
  } finally {
    store.close();
  }
});

test("mixed known/new pages continue until an entirely known page", async () => {
  let phase = 0;
  const { store, adapter, ctx, calls } = setup((url) => {
    const n = Number(url.searchParams.get("page"));
    if (phase === 0) return page([video]);
    if (n === 1) return page([video, { ...video, id: "9000001" }], 1, 2);
    if (n === 2) return page([{ ...video, id: "9000002" }], 2, 3);
    return page([video], 3);
  });
  try {
    await adapter.fetch("2026-07-01", ctx);
    phase = 1;
    const result = await adapter.fetch("2026-07-01", ctx);
    assert.equal(result.scenes.length, 3);
    assert.equal(calls.length, 4);
  } finally {
    store.close();
  }
});

test("request starts are spaced, and inline known tags are labels without a fetch filter", async () => {
  const times: number[] = [];
  const { store, ctx } = setup((url) => {
    times.push(Date.now());
    const n = Number(url.searchParams.get("page"));
    return page([{ ...video, id: String(n), tags: ["Anal"] }], n, n < 3 ? n + 1 : null);
  });
  const adapter = createSources({
    ...loadConfig({ LISZT_MANYVIDS_MIN_INTERVAL_MS: "20" }),
    store,
  }).find((s) => s.id === "manyvids-1003095958")!;
  try {
    const result = await adapter.fetch("2026-07-01", ctx);
    assert.deepEqual(result.scenes[0]!.tags, ["Anal"]);
    assert.ok(times[1]! - times[0]! >= 18);
    assert.ok(times[2]! - times[1]! >= 18);
  } finally {
    store.close();
  }
});

test("captured hour-long videos retain their full runtime in seconds", async () => {
  const body = JSON.parse(
    readFileSync(new URL("./fixtures/manyvids-hours-page.json", import.meta.url), "utf8"),
  );
  body.pagination = { total: 9, totalPages: 1, currentPage: 1, nextPage: null };
  const { store, adapter, ctx } = setup(() => body);
  try {
    const result = await adapter.fetch("2019-01-01", ctx);
    assert.equal(result.scenes[0]!.durationSec, 3711);
  } finally {
    store.close();
  }
});
