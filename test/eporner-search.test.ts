import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEpornerSearchUrl,
  createEpornerOpenLookup,
  createEpornerOpenSearch,
} from "../src/tubes/eporner.ts";
import { makeMatchScene } from "./helpers.ts";
import type { Fetcher } from "../src/sources/types.ts";

const videos = [
  {
    id: "good",
    url: "https://www.eporner.com/video-good/",
    embed: "https://www.eporner.com/embed/good/",
    title: "Marfe scene",
    length_sec: 600,
    added: "2026-06-01 12:00:00",
    views: "1,200",
  },
  {
    id: "old",
    url: "https://www.eporner.com/video-old/",
    embed: "https://www.eporner.com/embed/old/",
    title: "Marfe scene",
    length_sec: 600,
    added: "2025-01-01 12:00:00",
    views: "900,000",
  },
  {
    id: "long",
    url: "https://www.eporner.com/video-long/",
    embed: "https://www.eporner.com/embed/long/",
    title: "Marfe scene",
    length_sec: 720,
    added: "2026-06-01 12:00:00",
    views: "500,000",
  },
];

function fakeFetcher(onUrl: (url: string) => void = () => {}): Fetcher {
  return {
    fetch: async () => new Response("not used"),
    text: async () => "not used",
    json: async <T>(url: string) => {
      onUrl(url);
      return { videos } as T;
    },
  };
}

test("Eporner search explicitly excludes low-quality rows", () => {
  const url = new URL(buildEpornerSearchUrl("Marfe", 100));
  assert.equal(url.searchParams.get("query"), "Marfe");
  assert.equal(url.searchParams.get("lq"), "0");
  assert.equal(url.searchParams.get("per_page"), "100");
});

test("Eporner and Sxyprn share the same duration and date gates", async () => {
  const requested: string[] = [];
  const search = createEpornerOpenSearch({ fetcher: fakeFetcher((url) => requested.push(url)) });
  const lookup = createEpornerOpenLookup(search, { durationToleranceSec: 1, dateWindowDays: 7 });
  const matches = await lookup(
    makeMatchScene({
      id: "test:eporner",
      title: "Marfe scene",
      performers: ["Marfe"],
      releaseDate: "2026-06-01",
      durationSec: 600,
    }),
  );

  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.video.id, "good");
  assert.ok(matches[0]!.identityTier > 0);
  assert.ok(requested.length > 0);
  assert.ok(requested.every((url) => new URL(url).searchParams.get("lq") === "0"));
});

test("malformed Eporner search responses stay errors", async () => {
  const fetcher: Fetcher = {
    fetch: async () => new Response("not used"),
    text: async () => "not used",
    json: async <T>() => ({ malformed: true }) as T,
  };
  const search = createEpornerOpenSearch({ fetcher });
  await assert.rejects(search("Marfe"), /invalid response/);
});
