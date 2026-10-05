import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { createFc2CmadbStudio, FC2_LISTING_URL } from "../src/sources/fc2cmadb.ts";
import { createFc2EpornerResolver } from "../src/tubes/fc2-eporner.ts";
import { createSync } from "../src/pipeline/sync.ts";
import { fixedClock, type Fetcher } from "../src/sources/types.ts";
import { NullLogger } from "../src/core/logger.ts";
import { loadConfig } from "../src/config.ts";
import { buildReadModel } from "../src/serving/read-model.ts";

const fixture = (name: string) =>
  readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");
const now = new Date("2026-10-05T00:00:00Z");

test("FC2 multipart evidence survives a full sync, restart and repeat sync", async () => {
  const dir = mkdtempSync(join(tmpdir(), "liszt-fc2-parts-"));
  const path = join(dir, "catalogue.db");
  let store = new SqliteStore(path);
  const reads: string[] = [];
  const listing = `<script data-page="app" type="application/json">${JSON.stringify({
    component: "Tags/Show",
    props: {
      tag_name: "アナル",
      articles: {
        data: [
          {
            video_id: "4979341",
            title: "FC2 example",
            release_date: "2026-10-02",
            duration: "01:02:08",
            censored: "無",
            not_found: null,
            writer: { name: "seller" },
            pivot: { tag_id: 47 },
          },
        ],
        next_cursor: null,
      },
    },
    url: "/tags/アナル",
    version: "v",
  })}</script>`;
  const search = JSON.parse(fixture("eporner-fc2-search-4979341.json"));
  search.videos = search.videos.filter((video: { id: string }) =>
    ["a1b2c3", "d4e5f6", "look1", "look2"].includes(video.id),
  );
  const fetcher: Fetcher = {
    async fetch(url) {
      reads.push(url);
      if (url.startsWith(FC2_LISTING_URL)) return new Response(listing);
      if (url.includes("fc2cmadb.com/articles/")) {
        return new Response(fixture("fc2-detail-uncensored.html").replaceAll("4986883", "4979341"));
      }
      if (url.includes("/api/v2/video/search/")) {
        assert.equal(new URL(url).searchParams.get("query"), "4979341");
        return new Response(JSON.stringify(search), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/api/v2/video/id/")) {
        return new Response(JSON.stringify({ id: new URL(url).searchParams.get("id") }), {
          headers: { "content-type": "application/json" },
        });
      }
      for (const id of ["a1b2c3", "d4e5f6"]) {
        if (url.includes(`/video-${id}/`))
          return new Response(fixture(`eporner-fc2-video-${id}.html`), {
            headers: { "content-type": "text/html" },
          });
      }
      throw new Error(`Unexpected fixture request ${url}`);
    },
    async text(url) {
      return (await this.fetch(url)).text();
    },
    async json<T>(url: string): Promise<T> {
      return (await this.fetch(url)).json() as Promise<T>;
    },
  };
  const cycle = () =>
    createSync({
      store,
      sources: [createFc2CmadbStudio({ store, sleep: async () => {}, maxDetailChecksPerSync: 1 })],
      fetcher,
      clock: fixedClock(now.toISOString()),
      log: new NullLogger(),
      windowDays: 90,
      fetchConcurrency: 1,
      lookups: {
        poolLookup: null,
        sxyprnLookup: null,
        fc2Lookup: createFc2EpornerResolver(fetcher, {
          sleep: async () => {},
          minIntervalMs: 0,
          relatedBound: 0,
        }),
      },
    });
  const check = () => {
    const model = buildReadModel(store, loadConfig({}), now);
    assert.equal(model.scenes.length, 1);
    assert.deepEqual(
      model.scenes[0]!.videoUrls.map((link) => link.part),
      [1, 2],
    );
    assert.deepEqual(
      model.scenes[0]!.videoUrls.map((link) => link.verifyFailures),
      [0, 0],
    );
  };
  try {
    store.migrate();
    await cycle()("initial");
    check();
    assert.deepEqual(
      reads
        .filter((url) => url.includes("/api/v2/video/id/"))
        .map((url) => new URL(url).searchParams.get("id")),
      ["a1b2c3", "d4e5f6"],
    );
    store.close();
    store = new SqliteStore(path);
    store.migrate();
    check();
    await cycle()("repeat");
    check();
    assert.equal(reads.filter((url) => url.includes("fc2cmadb.com/articles/")).length, 1);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
