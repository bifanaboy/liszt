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
import { buildReadModel } from "../src/serving/read-model.ts";
import type { Config } from "../src/config.ts";
import { createProgressTracker, type SyncProgress } from "../src/pipeline/progress.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { NullLogger } from "../src/core/logger.ts";

function deps(over: Partial<HttpDeps> = {}): HttpDeps {
  const store = new SqliteStore(":memory:");
  store.migrate();
  return {
    store,
    log: new NullLogger(),
    readModel: () =>
      ({ generatedAt: "2026-03-04T00:00:00Z", scenes: [], sources: [], runs: [] }) as never,
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

test("/api/progress is small, live, and separate from the catalogue", async () => {
  // The meters are polled every couple of seconds. If they rode on
  // `/api/scenes` the dashboard would refetch ~137 KB of catalogue to move a
  // bar, and the list would re-sort under the reader's cursor on every tick.
  const d = deps();
  const tracker = createProgressTracker();
  tracker.begin("cycle-1", "2026-03-10T00:00:00Z", { sources: 6, uploaders: 4 });
  tracker.stage("populating");
  tracker.sourceStart("tushy");
  tracker.sourceDone("mambo-perv");
  d.progress = () => tracker.snapshot();
  await withServer(d, async (base) => {
    const response = await fetch(`${base}/api/progress`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    const body = (await response.json()) as { generatedAt: string; progress: SyncProgress };
    assert.equal(typeof body.generatedAt, "string");
    assert.equal(body.progress.active, true);
    assert.equal(body.progress.runId, "cycle-1");
    assert.equal(body.progress.populate.done, 1);
    assert.equal(body.progress.populate.total, 6);
    assert.equal(
      (await fetch(`${base}/api/scenes`)).headers.get("content-type"),
      response.headers.get("content-type"),
      "same origin, same policy",
    );
  });
  d.store.close();
});

test("the read model carries a progress snapshot, and defaults to an idle one", async () => {
  // The catalogue response includes the snapshot so a first paint that lands in
  // the middle of a cycle can already draw its stage. It is OPTIONAL on the way
  // in: every existing caller, including the fixture above, must keep working
  // without it - and a missing snapshot has to read as "no run", never as
  // "undefined", which would render a bar with no width and no denominator.
  const store = new SqliteStore(":memory:");
  store.migrate();
  const config = { windowDays: 90 } as Config;
  const idle = buildReadModel(store, config, new Date("2026-03-10T00:00:00Z"));
  assert.equal(idle.progress.active, false);
  assert.equal(idle.progress.stage, "idle");
  assert.equal(idle.progress.populate.total, 0);

  const tracker = createProgressTracker();
  tracker.begin("cycle-2", "2026-03-10T00:00:00Z", { sources: 6, uploaders: 4 });
  tracker.stage("linking");
  tracker.linkStart(121);
  tracker.linkStep(48, 121, 3);
  const live = buildReadModel(store, config, new Date("2026-03-10T00:00:00Z"), {
    refreshing: true,
    progress: tracker.snapshot(),
  });
  assert.equal(live.refreshing, true, "the boolean is kept alongside the new signal");
  assert.equal(live.progress.active, true);
  assert.equal(live.progress.runId, "cycle-2");
  assert.equal(live.progress.link.done, 48);
  assert.equal(live.progress.link.matched, 3);
  // The model must not hand out the tracker's own object: a later step would
  // mutate a response that was already being serialised.
  tracker.linkStep(49, 121, 3);
  assert.equal(live.progress.link.done, 48);
  store.close();
});

test("/api/progress answers an idle tracker rather than 404 or an empty body", async () => {
  // A dep-less server still has to answer: the dashboard polls this route from
  // the moment the page loads, long before anybody clicks refresh.
  const d = deps();
  await withServer(d, async (base) => {
    const body = (await (await fetch(`${base}/api/progress`)).json()) as { progress: SyncProgress };
    assert.equal(body.progress.active, false);
    assert.equal(body.progress.stage, "idle");
    assert.equal(body.progress.populate.total, 0);
  });
  d.store.close();
});

test("/api/progress is a read, not a trigger", async () => {
  // The refresh primitive is POST /api/refresh and nothing else. A GET that
  // started a cycle would make every prefetch and every crawler a refresh.
  const d = deps();
  let started = 0;
  d.refresh = async () => {
    started += 1;
    return undefined;
  };
  await withServer(d, async (base) => {
    assert.equal((await fetch(`${base}/api/progress`, { method: "GET" })).status, 200);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      assert.equal(
        (await fetch(`${base}/api/progress`, { method })).status,
        405,
        `${method} must not reach the route`,
      );
    }
    assert.equal(started, 0, "nothing this route did started a cycle");
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
        [1, 2, 3],
        "every migration applied, in filename order",
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
