import { test } from "node:test";
import assert from "node:assert/strict";
import type { Fetcher, FetchOptions } from "../src/sources/types.ts";
import {
  getStudioMetadataProfile,
  parseVixenResponse,
  scrapeReleaseMetadata,
} from "../src/sources/studio-metadata.ts";

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

function fixedFetcher(body: unknown, onFetch?: (url: string, options: FetchOptions) => void): Fetcher {
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
