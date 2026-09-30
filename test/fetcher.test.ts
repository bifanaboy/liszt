import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyStatus, FetchError, classifyError, HttpFetcher } from "../src/core/fetcher.ts";

test("404/410 are definitive; everything else is inconclusive", () => {
  assert.equal(classifyStatus(404), "definitive");
  assert.equal(classifyStatus(410), "definitive");
  for (const status of [400, 401, 403, 429, 500, 502, 503]) {
    assert.equal(classifyStatus(status), "inconclusive");
  }
});

test("classifyError defaults to inconclusive for non-FetchErrors", () => {
  assert.equal(classifyError(new Error("network down")), "inconclusive");
  assert.equal(classifyError(new FetchError("gone", "definitive", 404)), "definitive");
});
test("an unusable timeoutMs falls back to the default rather than escaping", async () => {
  // `AbortSignal.timeout` throws a RangeError for a negative or non-finite
  // delay, and the signal used to be built OUTSIDE the try - so a config typo
  // escaped as an unhandled RangeError, a shape `classifyError` cannot read.
  // The value is now validated, and an unusable one falls back to the default:
  // clamping is the safe direction, because the alternative is a request with
  // no deadline at all.
  const fetcher = new HttpFetcher(1000);
  const original = globalThis.fetch;
  const seenSignals: (AbortSignal | null | undefined)[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seenSignals.push(init.signal);
    return new Response("ok");
  }) as unknown as typeof globalThis.fetch;
  try {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const response = await fetcher.fetch("https://example.test/", { timeoutMs });
      assert.equal(response.status, 200, `timeoutMs=${timeoutMs} should fall back, not fail`);
      // The fallback still bounds the request, which is the whole point.
      assert.ok(seenSignals.at(-1) instanceof AbortSignal, "a deadline is still attached");
    }
    assert.equal((await fetcher.fetch("https://example.test/")).status, 200);
    assert.equal((await fetcher.fetch("https://example.test/", { timeoutMs: 50 })).status, 200);
  } finally {
    globalThis.fetch = original;
  }
});

test("a caller abort and our own deadline are reported differently", async () => {
  // Conflating them sends the wrong diagnosis into the logs: a shutdown reads
  // as a source timeout, and a source timeout reads as a shutdown.
  const fetcher = new HttpFetcher(10_000);
  const original = globalThis.fetch;
  globalThis.fetch = ((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    })) as unknown as typeof globalThis.fetch;
  try {
    const controller = new AbortController();
    const pending = fetcher.fetch("https://example.test/", { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, /aborted by the caller/);

    // The deadline path still says "timed out".
    await assert.rejects(
      fetcher.fetch("https://example.test/", { timeoutMs: 5 }),
      /timed out after 5ms/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
