/**
 * The HTTP surface, at the boundaries that matter now that the auth subsystem is
 * deleted:
 *
 *  - `GET /health` answers a constant. A platform health check needs a 2xx, and
 *    Render treats anything else as a failed deploy. The body is deliberately
 *    contentless: "the process is serving" is the entire claim, and nothing here
 *    should leak now that the app is public.
 *  - `/api/health` is a DIFFERENT route, and it is stateful. That is the whole
 *    reason `/health` exists separately.
 *  - There is no gate. `/login` and `/logout` are gone, so they fall through to
 *    the normal unknown-path 404 - with no redirect and, critically, no
 *    `set-cookie`. That is the regression guard for the deletion: a leftover
 *    route that quietly sets a cookie would be invisible until it leaked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHttpHandler, HEALTH_PATH, type HttpDeps } from "../src/serving/http.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { NullLogger } from "../src/core/logger.ts";

function deps(over: Partial<HttpDeps> = {}): HttpDeps {
  const store = new SqliteStore(":memory:");
  store.migrate();
  return {
    store,
    log: new NullLogger(),
    readModel: () => ({ generatedAt: "2026-03-04T00:00:00Z", scenes: [], sources: [], runs: [] }) as never,
    refresh: async () => undefined,
    isBusy: () => false,
    publicDir: new URL("../public", import.meta.url).pathname,
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

test("GET /health is 2xx, JSON, and says nothing about the deployment", async () => {
  const d = deps();
  assert.equal(HEALTH_PATH, "/health", "Render's healthCheckPath must keep resolving");
  await withServer(d, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200, "a health check that answers non-2xx fails the deploy");
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = (await response.json()) as Record<string, unknown>;
    assert.deepEqual(body, { status: "ok" });
    // No version, no host, no store state, no source health.
    assert.equal(Object.keys(body).length, 1);
    assert.equal(JSON.stringify(body).includes("liszt"), false);
  });
  d.store.close();
});

test("HEAD /health answers too, and is not a write primitive", async () => {
  const d = deps();
  await withServer(d, async (base) => {
    assert.equal((await fetch(`${base}/health`, { method: "HEAD" })).status, 200);
    assert.equal(
      (await fetch(`${base}/health`, { method: "POST" })).status,
      405,
      "only GET and HEAD reach the probe; anything else is a method error",
    );
  });
  d.store.close();
});

test("/api/health is a different route from /health", async () => {
  const d = deps();
  await withServer(d, async (base) => {
    const stateful = await fetch(`${base}/api/health`);
    assert.equal(stateful.status, 200);
    const body = (await stateful.json()) as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.ok(typeof body.ts === "string", "the stateful report carries a timestamp");
    assert.equal(
      Object.keys(body).includes("status"),
      false,
      "the two routes must not be mistaken for each other",
    );
  });
  d.store.close();
});

test("no route is gated, and nothing sets a cookie", async () => {
  const d = deps();
  await withServer(d, async (base) => {
    const routes = ["/api/scenes", "/api/sources", "/api/runs", "/api/health", "/"];
    for (const route of routes) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, `${route} is served to anyone who can reach the port`);
      assert.equal(
        response.headers.get("set-cookie"),
        null,
        `${route} must not set a cookie - the session layer is gone`,
      );
    }
    const refresh = await fetch(`${base}/api/refresh`, { method: "POST" });
    assert.equal(refresh.status, 202);
    assert.equal(refresh.headers.get("set-cookie"), null);
  });
  d.store.close();
});

test("the deleted auth routes are now plain 404s", async () => {
  // The regression guard for the deletion. A leftover branch that still served
  // `/login` would redirect, and one that still cleared a cookie would emit a
  // `set-cookie` on a route that no longer has a session to clear.
  const d = deps();
  await withServer(d, async (base) => {
    for (const [method, route] of [
      ["GET", "/login"],
      ["POST", "/login"],
      ["GET", "/logout"],
      ["POST", "/logout"],
      ["GET", "/login.js"],
      ["GET", "/login.css"],
      ["GET", "/login.html"],
    ] as const) {
      const response = await fetch(`${base}${route}`, { method, redirect: "manual" });
      // A GET on a path with no file behind it is a 404; any other method on an
      // unrouted path is the generic 405. Both mean the same thing here: no
      // route answered. What matters is that neither is a live endpoint.
      assert.equal(
        response.status,
        method === "GET" ? 404 : 405,
        `${method} ${route} must not be a route any more`,
      );
      assert.equal(response.headers.get("location"), null, `${route} must not redirect`);
      assert.equal(response.headers.get("set-cookie"), null, `${route} must not set a cookie`);
    }
  });
  d.store.close();
});

test("the sessions table is gone after migrating", () => {
  // The migration must actually drop it, not merely stop writing to it: an
  // unused table holding token hashes is exactly the kind of thing a later
  // reader assumes is load-bearing. Checked against the file on disk with a
  // second connection rather than through the store, so no query API is added
  // to production code purely so a test can look inside it.
  const path = join(tmpdir(), `liszt-migration-${process.pid}-${Date.now()}.db`);
  try {
    new SqliteStore(path).migrate();
    const db = new DatabaseSync(path);
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .all();
      assert.deepEqual(tables, [], "0002_drop_sessions.sql must remove the table");
      const applied = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      assert.deepEqual(
        applied.map((row) => Number((row as { version: number }).version)),
        [1, 2],
        "both migrations applied, in filename order",
      );
      // And migrating again is a no-op rather than a second drop attempt.
      new SqliteStore(path).migrate();
      assert.deepEqual(db.prepare("SELECT version FROM schema_migrations").all(), applied);
    } finally {
      db.close();
    }
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  }
});