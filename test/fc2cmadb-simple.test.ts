import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFc2CmadbStudio } from "../src/sources/fc2cmadb.ts";
import type { Fetcher, SourceContext } from "../src/sources/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const NOW = new Date("2026-10-03T00:00:00Z");
const WINDOW_START = "2026-07-05";
const noSleep = async (): Promise<void> => {};

function stubFetcher(
  pages: Record<string, string | ((url: string) => string)>,
): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const keys = Object.keys(pages).sort((a, b) => b.length - a.length);
  return {
    calls,
    async fetch(url: string): Promise<Response> {
      calls.push(url);
      const key = keys.find((candidate) => url.startsWith(candidate));
      const page = key === undefined ? undefined : pages[key];
      if (page === undefined) return new Response("missing", { status: 404 });
      const body = typeof page === "function" ? page(url) : page;
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
    async text(url: string): Promise<string> {
      return (await this.fetch(url)).text();
    },
    async json<T>(url: string): Promise<T> {
      return (await this.fetch(url)).json() as T;
    },
  };
}

function context(fetcher: Fetcher, now = NOW): SourceContext {
  return {
    fetcher,
    now,
    log: () => {},
    mapWithConcurrency: (items, task) => Promise.all(items.map(task)),
    mapIsolated: (items, task) => Promise.all(items.map(task)),
  };
}

/** The real adapter, driven through its own fetch(). */
async function runLane(fetcher: Fetcher, windowStart = WINDOW_START) {
  const studio = createFc2CmadbStudio({ sleep: noSleep });
  return studio.fetch(windowStart, context(fetcher));
}

test("the adapter emits scenes and drops censored and trans records", async () => {
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": fixture(
      "fc2-anal-listing-page-1.html",
    ),
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": fixture(
      "fc2-anal-listing-final.html",
    ),
  });
  const result = await runLane(fetcher);

  assert.equal(result.verifiedEmpty, false);
  assert.equal(result.scenes.length, 3);
  const ids = result.scenes.map((scene) => scene.sourceSceneId).sort();
  assert.deepEqual(ids, ["4986048", "4986794", "4986883"]);

  const scene = result.scenes.find((item) => item.sourceSceneId === "4986883");
  assert.ok(scene);
  assert.equal(scene.title.includes("托卵実録"), true);
  assert.equal(scene.releaseDate, "2026-10-02");
  assert.equal(scene.durationSec, 3728); // 01:02:08
  assert.deepEqual(scene.tags, []);
  assert.ok(scene.thumbnailUrl?.includes("contents-thumbnail2.fc2.com"));
  assert.equal(scene.releaseUrl, "https://fc2cmadb.com/articles/4986883");
  assert.deepEqual(scene.provenance?.audit, {
    fc2Censorship: "unmarked",
    fc2Tag: "アナル",
  });
});

test("the adapter reports a clean empty when the window has nothing", async () => {
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": fixture("fc2-anal-listing-final.html"),
  });
  const result = await runLane(fetcher);
  assert.deepEqual(result.scenes, []);
  assert.equal(result.verifiedEmpty, true);
});

test("the adapter withholds verifiedEmpty at a window edge with a cursor", async () => {
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": fixture(
      "fc2-anal-listing-page-1.html",
    ),
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": fixture(
      "fc2-anal-listing-edge-page.html",
    ),
  });
  const result = await runLane(fetcher);
  assert.equal(result.scenes.length, 3);
  assert.equal(result.verifiedEmpty, false);
});

test("the adapter drops a safety term found in the title", async () => {
  // The page-1 fixture with one title rewritten to carry a safety term.
  const listing = fixture("fc2-anal-listing-page-1.html").replace("【托卵実録】", "【小学生個撮】");
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": listing,
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": fixture(
      "fc2-anal-listing-final.html",
    ),
  });
  const result = await runLane(fetcher);
  assert.equal(result.scenes.length, 2);
  assert.equal(
    result.scenes.some((scene) => scene.sourceSceneId === "4986883"),
    false,
    "a safety term in the title drops the record",
  );
});

test("the adapter drops an image set whose duration is a count, not a clock", async () => {
  // The page-1 fixture with the first record's duration set to an image count.
  const listing = fixture("fc2-anal-listing-page-1.html").replace(
    '"duration": "01:02:08"',
    '"duration": "60枚"',
  );
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": listing,
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": fixture(
      "fc2-anal-listing-final.html",
    ),
  });
  const result = await runLane(fetcher);
  assert.equal(result.scenes.length, 2);
  assert.equal(
    result.scenes.some((scene) => scene.sourceSceneId === "4986883"),
    false,
    "a record with no playable duration is not a scene",
  );
});

test("the adapter reports censored and removed records as excluded", async () => {
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": fixture(
      "fc2-anal-listing-page-1.html",
    ),
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": fixture(
      "fc2-anal-listing-final.html",
    ),
  });
  const result = await runLane(fetcher);
  assert.deepEqual(result.excludedSceneIds, ["4986752"]);
});
