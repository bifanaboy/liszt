import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { createSxyprnRelayApi } from "../lib/tubes/sxyprn-client.js";
import { createSxyprnRelayHandler } from "../relay/server.js";

const SECRET = "relay-test-secret";
const POST_URL = "https://sxyprn.com/post/6ab1a9bec8445.html";
const calls = [];
const handler = createSxyprnRelayHandler({
  secret: SECRET,
  timeoutMs: 30,
  api: {
    videos: {
      search: async (query, options) => {
        calls.push(["search", query, options]);
        return {
          videos: [
            {
              url: POST_URL,
              title: "Verified scene",
              durationSeconds: 1418,
              views: "12345",
              isExternal: false,
              rawHtml: "private page content",
            },
          ],
        };
      },
      details: async ({ url }) => {
        calls.push(["details", url]);
        return {
          url,
          title: "Verified scene",
          durationSeconds: 1418,
          streamUrl: "https://sxyprn.com/stream.m3u8",
          uploadDate: "2026-03-05T10:00:00+00:00",
          views: "12345",
          sizeBytes: 4096,
          rawHtml: "private page content",
        };
      },
    },
  },
});

test("Hatchable relay API uses only its configured secure host and authenticates", async () => {
  const requests = [];
  const api = createSxyprnRelayApi({
    url: "https://relay.example",
    secret: SECRET,
    fetchImpl: async (url, options) => {
      requests.push([String(url), options]);
      return new Response(
        JSON.stringify(
          String(url).endsWith("/search")
            ? { videos: [{ url: POST_URL, title: "Verified scene", durationSeconds: 1418 }] }
            : {
                url: POST_URL,
                title: "Verified scene",
                durationSeconds: 1418,
                uploadDate: "2026-03-05T10:00:00+00:00",
              },
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    },
  });

  assert.deepEqual(await api.videos.search("scene name", { page: 0 }), {
    videos: [{ url: POST_URL, title: "Verified scene", durationSeconds: 1418 }],
  });
  assert.equal(
    (await api.videos.details({ url: POST_URL })).uploadDate,
    "2026-03-05T10:00:00+00:00",
  );
  assert.deepEqual(
    requests.map(([url]) => url),
    ["https://relay.example/v1/search", "https://relay.example/v1/details"],
  );
  assert.deepEqual(
    requests.map(([, options]) => options.method),
    ["POST", "POST"],
  );
  assert.deepEqual(
    requests.map(([, options]) => options.headers.authorization),
    [`Bearer ${SECRET}`, `Bearer ${SECRET}`],
  );
  assert.deepEqual(JSON.parse(requests[0][1].body), { query: "scene name" });
  assert.deepEqual(JSON.parse(requests[1][1].body), { url: POST_URL });
  assert.ok(requests.every(([, options]) => options.redirect === "error"));
});

test("Hatchable relay API rejects unsafe configuration and never exposes relay error bodies", async () => {
  assert.throws(
    () => createSxyprnRelayApi({ url: "http://relay.example", secret: SECRET }),
    /HTTPS/,
  );
  assert.throws(() => createSxyprnRelayApi({ url: "https://relay.example", secret: "" }), /secret/);
  let calls = 0;
  const api = createSxyprnRelayApi({
    url: "https://relay.example",
    secret: SECRET,
    fetchImpl: async () => {
      calls += 1;
      return new Response("upstream page body and relay-test-secret", { status: 502 });
    },
  });
  await assert.rejects(api.videos.details({ url: "https://attacker.example/" }), /Sxyprn post URL/);
  assert.equal(calls, 0);
  await assert.rejects(api.videos.search("scene"), (error) => {
    assert.match(error.message, /HTTP 502/);
    assert.doesNotMatch(error.message, /upstream page body|relay-test-secret/);
    return true;
  });
  assert.equal(calls, 1);
});

test("Hatchable relay API stops reading a response as soon as its size limit is known", async () => {
  let consumed = false;
  let canceled = false;
  const api = createSxyprnRelayApi({
    url: "https://relay.example",
    secret: SECRET,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "70000" },
      body: {
        cancel: async () => {
          canceled = true;
        },
      },
      text: async () => {
        consumed = true;
        return "oversized";
      },
    }),
  });
  await assert.rejects(api.videos.search("scene"), /size limit/);
  assert.equal(consumed, false);
  assert.equal(canceled, true);
});

async function dispatch(
  route,
  { path, body, secret = SECRET, method = "POST", contentType = "application/json" },
) {
  const request = Readable.from([Buffer.from(body)]);
  request.method = method;
  request.url = path;
  request.headers = {
    authorization: `Bearer ${secret}`,
    "content-type": contentType,
  };
  return new Promise((resolve, reject) => {
    const response = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(text) {
        resolve({ status: this.status, headers: this.headers, text: String(text) });
      },
    };
    route(request, response).catch(reject);
  });
}

async function send(route, path, input, options = {}) {
  return dispatch(route, { path, body: JSON.stringify(input), ...options });
}

test("relay requires its shared secret before calling Sxyprn", async () => {
  const before = calls.length;
  const response = await send(
    handler,
    "/v1/search",
    { query: "a scene" },
    { secret: "wrong-secret" },
  );
  assert.equal(response.status, 401);
  assert.equal(calls.length, before);
});

test("search relay returns only the fields used by the matcher", async () => {
  const response = await send(handler, "/v1/search", { query: "a scene" });
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.text), {
    videos: [
      {
        url: POST_URL,
        title: "Verified scene",
        durationSeconds: 1418,
        views: "12345",
        isExternal: false,
      },
    ],
  });
  assert.deepEqual(calls.at(-1), ["search", "a scene", { page: 0 }]);
});

test("details relay accepts only a real Sxyprn post URL", async () => {
  const valid = await send(handler, "/v1/details", { url: POST_URL });
  assert.equal(valid.status, 200);
  assert.deepEqual(JSON.parse(valid.text), {
    url: POST_URL,
    title: "Verified scene",
    durationSeconds: 1418,
    streamUrl: "https://sxyprn.com/stream.m3u8",
    uploadDate: "2026-03-05T10:00:00+00:00",
    views: "12345",
    sizeBytes: 4096,
  });

  for (const url of [
    "https://example.com/post/6ab1a9bec8445.html",
    "https://sxyprn.com.evil.example/post/6ab1a9bec8445.html",
    "http://sxyprn.com/post/6ab1a9bec8445.html",
    "https://sxyprn.com:444/post/6ab1a9bec8445.html",
    "https://sxyprn.com/post/6ab1a9bec8445.html?redirect=https://example.com",
  ]) {
    const response = await send(handler, "/v1/details", { url });
    assert.equal(response.status, 400, url);
  }
});

test("relay rejects unknown paths and oversized request bodies", async () => {
  const unknown = await send(handler, "/v1/fetch", { url: POST_URL });
  assert.equal(unknown.status, 404);
  const large = await dispatch(handler, {
    path: "/v1/search",
    body: JSON.stringify({ query: "x".repeat(20_000) }),
  });
  assert.equal(large.status, 413);
});

test("upstream failures are bounded and their private details are not returned or logged", async () => {
  const failure = "private page body and relay-test-secret";
  const broken = createSxyprnRelayHandler({
    secret: SECRET,
    timeoutMs: 20,
    api: {
      videos: {
        search: async () => {
          throw new Error(failure);
        },
        details: async () => ({}),
      },
    },
  });
  const logs = [];
  const originalError = console.error;
  console.error = (...values) => logs.push(values.join(" "));
  try {
    const response = await send(broken, "/v1/search", { query: "a scene" });
    assert.equal(response.status, 502);
    assert.doesNotMatch(response.text, /private page body|relay-test-secret/);
    assert.doesNotMatch(logs.join(" "), /private page body|relay-test-secret/);
  } finally {
    console.error = originalError;
  }

  const slow = createSxyprnRelayHandler({
    secret: SECRET,
    timeoutMs: 20,
    api: { videos: { search: () => new Promise(() => {}), details: async () => ({}) } },
  });
  const response = await send(slow, "/v1/search", { query: "a scene" });
  assert.equal(response.status, 504);
});

test("relay serializes search and detail calls before entering the package", async () => {
  const first = Promise.withResolvers();
  const calls = [];
  const route = createSxyprnRelayHandler({
    secret: SECRET,
    api: {
      videos: {
        search() {
          calls.push("search");
          return first.promise;
        },
        details() {
          calls.push("details");
          return {};
        },
      },
    },
  });
  const search = send(route, "/v1/search", { query: "first" });
  const details = send(route, "/v1/details", { url: POST_URL });
  await setImmediate();
  assert.deepEqual(calls, ["search"]);
  first.resolve({ videos: [] });
  assert.deepEqual(
    (await Promise.all([search, details])).map((r) => r.status),
    [200, 200],
  );
  assert.deepEqual(calls, ["search", "details"]);
});

test("relay removes expired waiters and holds a timed-out active slot until settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const first = Promise.withResolvers();
  const calls = [];
  const route = createSxyprnRelayHandler({
    secret: SECRET,
    timeoutMs: 100,
    api: {
      videos: {
        search(query) {
          calls.push(query);
          return query === "active" ? first.promise : { videos: [] };
        },
        details: async () => ({}),
      },
    },
  });
  const active = send(route, "/v1/search", { query: "active" });
  const expired = send(route, "/v1/search", { query: "expired" });
  await setImmediate();
  t.mock.timers.tick(100);
  assert.deepEqual(
    (await Promise.all([active, expired])).map((r) => r.status),
    [504, 504],
  );
  const fresh = send(route, "/v1/search", { query: "fresh" });
  await setImmediate();
  assert.deepEqual(calls, ["active"]);
  first.reject(new Error("late package failure"));
  assert.equal((await fresh).status, 200);
  assert.deepEqual(calls, ["active", "fresh"]);
});

test("relay checks queued deadlines even when timeout callbacks have not run", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const first = Promise.withResolvers();
  let calls = 0;
  const route = createSxyprnRelayHandler({
    secret: SECRET,
    timeoutMs: 100,
    api: {
      videos: {
        search() {
          calls += 1;
          return first.promise;
        },
        details: async () => ({}),
      },
    },
  });
  const active = send(route, "/v1/search", { query: "active" });
  const queued = send(route, "/v1/search", { query: "queued" });
  await setImmediate();
  t.mock.timers.setTime(101);
  first.resolve({ videos: [] });
  await active;
  assert.equal((await queued).status, 504);
  assert.equal(calls, 1);
});

test("relay rejects excess queued requests before calling the package", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const first = Promise.withResolvers();
  let calls = 0;
  const route = createSxyprnRelayHandler({
    secret: SECRET,
    timeoutMs: 100,
    api: {
      videos: {
        search() {
          calls += 1;
          return first.promise;
        },
        details: async () => ({}),
      },
    },
  });
  const admitted = Array.from({ length: 33 }, (_, i) =>
    send(route, "/v1/search", { query: String(i) }),
  );
  await setImmediate();
  assert.equal((await send(route, "/v1/search", { query: "overflow" })).status, 503);
  assert.equal(calls, 1);
  t.mock.timers.tick(100);
  assert.ok((await Promise.all(admitted)).every((r) => r.status === 504));
  first.resolve({ videos: [] });
  await setImmediate();
  assert.equal((await send(route, "/v1/search", { query: "after expiry" })).status, 200);
  assert.equal(calls, 2);
});
