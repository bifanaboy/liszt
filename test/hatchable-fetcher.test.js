import { test } from "node:test";
import assert from "node:assert/strict";
import { FetchError, HttpFetcher, classifyStatus } from "../lib/fetcher.js";

test("only missing resources are classified as definitive", () => {
  assert.equal(classifyStatus(404), "definitive");
  assert.equal(classifyStatus(410), "definitive");
  assert.equal(classifyStatus(403), "inconclusive");
  assert.equal(classifyStatus(429), "inconclusive");
  assert.equal(classifyStatus(503), "inconclusive");
});

test("requests carry the configured user agent and caller headers", async () => {
  let options;
  const fetcher = new HttpFetcher(1000, "Liszt test", async (_url, init) => {
    options = init;
    return new Response("ok");
  });
  assert.equal(
    await fetcher.text("https://example.com", { headers: { accept: "text/plain" } }),
    "ok",
  );
  assert.equal(options.headers["user-agent"], "Liszt test");
  assert.equal(options.headers.accept, "text/plain");
  assert.equal(options.redirect, "manual");
});

test("redirects and bad status responses fail with classified errors", async () => {
  const missing = new HttpFetcher(1000, "test", async () => new Response("gone", { status: 404 }));
  await assert.rejects(
    missing.text("https://example.com/missing"),
    (error) => error instanceof FetchError && error.kind === "definitive" && error.status === 404,
  );
  const redirect = new HttpFetcher(
    1000,
    "test",
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://example.com/next" },
      }),
  );
  await assert.rejects(redirect.text("https://example.com"), /302 -> https:\/\/example.com\/next/);
});

test("invalid JSON is an inconclusive fetch failure", async () => {
  const fetcher = new HttpFetcher(1000, "test", async () => new Response("not json"));
  await assert.rejects(
    fetcher.json("https://example.com/data"),
    (error) =>
      error instanceof FetchError &&
      error.kind === "inconclusive" &&
      /invalid JSON/.test(error.message),
  );
});
