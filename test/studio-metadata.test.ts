import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetcher, FetchOptions } from "../src/sources/types.ts";
import {
  getStudioMetadataProfile,
  parseVixenResponse,
  scrapeReleaseMetadata,
} from "../src/sources/studio-metadata.ts";
import { extractStudioMetadata, isUrlAllowed } from "../src/sources/studio-site.ts";

function htmlFetcher(html: string, onFetch?: (url: string) => void): Fetcher {
  return {
    async fetch(url) {
      onFetch?.(url);
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    },
    async text() {
      return html;
    },
    async json() {
      throw new Error("unused");
    },
  };
}

const SLUG = "hotel-vixen-season-3-episode-12-it-got-better";

function vixenResponse(slug = SLUG): unknown {
  return {
    data: {
      findOneVideo: {
        slug,
        title: "Hotel Vixen Season 3 Episode 12: It Got Better",
        releaseDate: "2026-10-02T00:00:00Z",
        runLength: "00:25:51",
        models: [{ name: "Nicole Kitt" }, { name: "Alberto Blanco" }],
        categories: [{ name: "Anal" }],
        images: { poster: [{ src: "https://cdn.tushy.test/small.jpg", width: 400 }] },
      },
    },
  };
}

function fixedFetcher(
  body: unknown,
  onFetch?: (url: string, options: FetchOptions) => void,
): Fetcher {
  return {
    async fetch(url, options = {}) {
      onFetch?.(url, options);
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    },
    async text() {
      throw new Error("unused");
    },
    async json() {
      throw new Error("unused");
    },
  };
}

test("Vixen detail parser reads fields from the exact scene response", () => {
  const result = parseVixenResponse(vixenResponse(), SLUG);
  assert.equal(result?.title, "Hotel Vixen Season 3 Episode 12: It Got Better");
  assert.equal(result?.releaseDate, "2026-10-02");
  assert.equal(result?.durationSec, 1551);
  assert.deepEqual(result?.performers, ["Nicole Kitt", "Alberto Blanco"]);
  assert.deepEqual(result?.tags, ["Anal"]);
  assert.equal(result?.thumbnailUrl, "https://cdn.tushy.test/small.jpg");
  assert.equal(result?.fieldProvenance?.durationSec, "studio-site");
});

test("Vixen detail parser rejects a response for a different scene slug", () => {
  assert.equal(parseVixenResponse(vixenResponse("a-different-release"), SLUG), null);
});

test("studio detail lookup posts the exact Vixen slug to its matching GraphQL host", async () => {
  let requestedUrl = "";
  let requestedBody: Record<string, unknown> = {};
  const result = await scrapeReleaseMetadata(
    `https://www.tushy.com/videos/${SLUG}`,
    fixedFetcher(vixenResponse(), (url, options) => {
      requestedUrl = url;
      requestedBody = JSON.parse(options.body ?? "{}") as Record<string, unknown>;
    }),
  );

  assert.equal(requestedUrl, "https://www.tushy.com/graphql");
  assert.deepEqual(requestedBody.variables, { site: "TUSHY", videoSlug: SLUG });
  assert.equal(result?.durationSec, 1551);
});

test("studio detail profiles cover the Vixen sites and reject unregistered hosts", () => {
  for (const host of [
    "www.blacked.com",
    "www.blackedraw.com",
    "www.deeper.com",
    "www.milfy.com",
    "www.tushy.com",
    "www.tushyraw.com",
    "www.slayed.com",
    "www.vixen.com",
    "www.wifey.com",
  ]) {
    assert.ok(getStudioMetadataProfile(`https://${host}/videos/example`), host);
  }
  assert.equal(getStudioMetadataProfile("https://www.tushy.com.evil.test/videos/x"), null);
  assert.equal(getStudioMetadataProfile("http://www.tushy.com/videos/x"), null);
});

test("studio page profiles cover the registered Stash scene hosts", () => {
  for (const host of [
    "sexlikereal.com",
    "www.sexlikereal.com",
    "analvids.com",
    "www.analvids.com",
    "pissvids.com",
    "www.pissvids.com",
    "bustyworld.com",
    "www.bustyworld.com",
    "woodmancastingx.com",
    "www.woodmancastingx.com",
  ]) {
    assert.equal(getStudioMetadataProfile(`https://${host}/watch/123`)?.kind, "studio-page");
  }
  assert.equal(getStudioMetadataProfile("https://traxxx.me/scene/123"), null);
  assert.equal(getStudioMetadataProfile("https://lancelotstyles.com/videos/123"), null);
});

test("Woodman page extraction follows the Stash scene fields and does not claim runtime", async () => {
  const html = `
    <h1>Behind the Scenes with Alex</h1>
    <p><span>Published</span>: 2026-10-02</p>
    <a class="girl_item"><span class="name">Alex</span></a>
    <a class="girl_item"><span class="name">Jamie</span></a>
    <a class="tag">Casting</a><a class="tag">Behind the Scenes</a>
    <script>image: "https://cdn.example.test/poster.jpg"</script>
  `;
  const fetcher: Fetcher = {
    async fetch() {
      return new Response(html, { headers: { "content-type": "text/html" } });
    },
    async text() {
      return html;
    },
    async json() {
      throw new Error("unused");
    },
  };
  const result = await scrapeReleaseMetadata("https://www.woodmancastingx.com/scene/123", fetcher);
  assert.equal(result?.title, "Behind the Scenes with Alex");
  assert.equal(result?.releaseDate, "2026-10-02");
  assert.deepEqual(result?.performers, ["Alex", "Jamie"]);
  assert.deepEqual(result?.tags, ["Casting", "Behind the Scenes"]);
  assert.equal(result?.thumbnailUrl, "https://cdn.example.test/poster.jpg");
  assert.equal(result?.durationSec, undefined);
});

test("a page that names a different release is not used", async () => {
  const html = `
    <link rel="canonical" href="https://www.sexlikereal.com/watch/999">
    <h1>Someone else's scene</h1>
    <script>{"duration":"PT30M"}</script>
  `;
  const result = await scrapeReleaseMetadata(
    "https://www.sexlikereal.com/watch/123",
    htmlFetcher(html),
  );
  assert.equal(result, null);
});

test("a malformed page date is dropped instead of failing the scene", async () => {
  const html = `
    <h1>A scene with a broken date</h1>
    <i class="bi-calendar3"></i> 2026-02-31
    <script>{"duration":"PT30M"}</script>
  `;
  const result = await scrapeReleaseMetadata(
    "https://www.bustyworld.com/watch/123",
    htmlFetcher(html),
  );
  assert.equal(result?.releaseDate, undefined);
  assert.equal(result?.title, "A scene with a broken date");
});

test("BustyWorld performer names are read from the link text, not the markup", () => {
  const html = `<h1 class="watch__title"><a href="/p/1">Jane Doe</a></h1>`;
  assert.deepEqual(extractStudioMetadata(html, "https://www.bustyworld.com/watch/123").performers, [
    "Jane Doe",
  ]);
});

test("an inherited object property is not a registered studio host", () => {
  for (const host of ["constructor", "__proto__", "toString"]) {
    assert.equal(getStudioMetadataProfile(`https://${host}/videos/example`), null, host);
  }
});

test("a redirect cannot move the request to another port or with credentials", () => {
  assert.equal(isUrlAllowed(new URL("https://www.sexlikereal.com:8443/watch/1")), false);
  assert.equal(isUrlAllowed(new URL("https://user@www.sexlikereal.com/watch/1")), false);
  assert.equal(isUrlAllowed(new URL("https://www.sexlikereal.com/watch/1")), true);
});
