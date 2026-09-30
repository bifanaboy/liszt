/**
 * The HTTP surface, at the two boundaries that matter:
 *
 *  - `GET /health` is PUBLIC and answers a constant. A platform health check
 *    needs a 2xx, and Render treats anything else as a failed deploy - which is
 *    why it cannot be `/api/health`, since that one is auth-gated and answers
 *    401. The body is deliberately contentless: "the process is serving" is the
 *    entire claim.
 *  - `authDisabled` is NOT honoured in production. The composition root already
 *    refuses to boot in that state, so reaching the handler with both set means a
 *    misconfigured deploy, and the only safe reading of that is "keep the gate".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authGateEnabled, createHttpHandler, type HttpDeps } from "../src/serving/http.ts";
import { loadConfig } from "../src/config.ts";
import { createSessionService } from "../src/auth/session.ts";
import { LoginThrottle } from "../src/auth/throttle.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { NullLogger } from "../src/core/logger.ts";
import { isPublicPath } from "../src/auth/middleware.ts";

const HASH = "scrypt$32768$8$1$c2FsdHNhbHRzYWx0c2E$" + Buffer.alloc(32).toString("base64");

function deps(over: Partial<HttpDeps> = {}): HttpDeps {
  const store = new SqliteStore(":memory:");
  store.migrate();
  return {
    config: loadConfig({ LISZT_AUTH_PASSWORD_HASH: HASH }),
    store,
    log: new NullLogger(),
    sessions: createSessionService(store),
    throttle: new LoginThrottle({ maxFailures: 10, lockoutMinutes: 15, now: () => 0 }),
    readModel: () => ({ generatedAt: "2026-03-04T00:00:00Z", scenes: [], sources: [], runs: [] }) as never,
    refresh: async () => undefined,
    isBusy: () => false,
    publicDir: new URL("../public", import.meta.url).pathname,
    cookieSecure: false,
    verifyPassword: async () => false,
    ...over,
  };
}

async function withServer(
  handlerDeps: HttpDeps,
  run: (base: string) => Promise<void>,
): Promise<Server> {
  const server = createServer(createHttpHandler(handlerDeps));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return server;
}

test("GET /health is public, 2xx, and says nothing about the deployment", async () => {
  const d = deps();
  await withServer(d, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200, "a health check that answers 401 fails the deploy");
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { status: "ok" });
    // No version, no host, no store state, no source health.
    assert.equal(Object.keys(body).length, 1);
    assert.equal(JSON.stringify(body).includes("liszt"), false);
  });
  d.store.close();
});

test("GET /api/health is still gated, and is a different route from /health", async () => {
  const d = deps();
  await withServer(d, async (base) => {
    const gated = await fetch(`${base}/api/health`);
    assert.equal(gated.status, 401, "the stateful health report must not be public");
    assert.equal(isPublicPath("GET", "/api/health"), false);
    assert.equal(isPublicPath("GET", "/health"), true);
    assert.equal(isPublicPath("GET", "/api/scenes"), false);
    // A non-GET on the probe is not public: it must not be a write primitive.
    assert.equal(isPublicPath("POST", "/health"), false);
    // Login assets and the splash stay public.
    assert.equal(isPublicPath("GET", "/login"), true);
    assert.equal(isPublicPath("GET", "/login.js"), true);
    assert.equal(isPublicPath("GET", "/"), false);
  });
  d.store.close();
});

test("authDisabled is a development opt-out, refused in production", () => {
  const enabled = loadConfig({});
  const disabled = loadConfig({ LISZT_AUTH_DISABLED: "true", LISZT_AUTH_PASSWORD_HASH: HASH });
  assert.equal(authGateEnabled(enabled, "production"), true);
  assert.equal(authGateEnabled(disabled, "development"), false, "local dev opt-out still works");
  assert.equal(authGateEnabled(disabled, "test"), false);
  assert.equal(
    authGateEnabled(disabled, "production"),
    true,
    "fail closed: reaching here with both set is a misconfigured deploy",
  );
});

test("a disabled gate outside production logs a warning at construction", () => {
  const lines: string[] = [];
  const d = deps({
    config: loadConfig({ LISZT_AUTH_DISABLED: "true" }),
    log: Object.assign(new NullLogger(), {
      warn: (message: string) => lines.push(message),
    }) as never,
  });
  createHttpHandler(d);
  assert.equal(lines.length, 1, "an unauthenticated surface is a deployment fact, logged once");
  assert.match(lines[0] ?? "", /auth is disabled/);
  d.store.close();
});
