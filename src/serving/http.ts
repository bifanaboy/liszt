/**
 * The HTTP surface. Plain `node:http`, no framework: the route table is small.
 *
 * THERE IS NO PERIMETER. Every route below is served to anyone who can reach the
 * port, including `POST /api/refresh`. That is the deliberate shape of this
 * deployment - a disposable public read model with no user accounts or private
 * catalogue data. The optional TPDB credential is only used for source requests.
 *
 * `/health` is the one route with a fixed body: a constant, no version, no host,
 * no store state. It is Render's deploy gate, and a health check that leaked
 * anything would leak it to whoever felt like asking.
 *
 * All responses are `no-store`, so no edge caches the catalogue, and static
 * serving is path-traversal safe by construction: the resolved target must stay
 * inside `publicDir`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import type { Logger } from "../core/logger.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
import { idleProgress, type SyncProgress } from "../pipeline/progress.ts";
import type { ReadModel } from "./read-model.ts";

/**
 * Render's deploy gate. Answered before anything else touches store or source
 * state, and the body is a constant: the process is up and serving, which is the
 * entire claim.
 */
export const HEALTH_PATH = "/health";

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
});

export interface HttpDeps {
  store: SqliteStore;
  log: Logger;
  /** Build the read model, including the current refreshing flag. */
  readModel: () => ReadModel;
  /** Start or join the single in-flight sync cycle. */
  refresh: () => Promise<unknown>;
  isBusy: () => boolean;
  publicDir: string;
  /**
   * The live cycle's progress, for `GET /api/progress`.
   *
   * A dedicated route because the meters change every couple of seconds and
   * `/api/scenes` is the whole catalogue: refetching that to move a bar would
   * re-sort the list under the reader's cursor. Status and data are separate
   * channels on purpose.
   */
  progress?: () => SyncProgress;
}

function send(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

/** Resolve a URL path to a file inside `publicDir`, or null on traversal. */
function staticTarget(publicDir: string, pathname: string): string | null {
  const root = resolve(publicDir);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(join(root, relative));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

async function serveStatic(deps: HttpDeps, pathname: string, res: ServerResponse): Promise<void> {
  const target = staticTarget(deps.publicDir, pathname);
  if (!target) {
    send(res, 403, "text/plain; charset=utf-8", "forbidden\n");
    return;
  }
  try {
    const body = await readFile(target);
    send(
      res,
      200,
      CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      body,
    );
  } catch {
    send(res, 404, "text/plain; charset=utf-8", "not found\n");
  }
}

export function createHttpHandler(
  deps: HttpDeps,
): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handle(deps, request, response).catch((error) => {
      deps.log.error("request failed", { error: (error as Error).message });
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
      else response.end();
    });
  };
}

async function handle(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  // Before anything that can touch the store or a source. `/health` must answer
  // even while a sync holds the database, or a deploy would be declared failed
  // by the very cycle it is waiting on.
  if (path === HEALTH_PATH && (method === "GET" || method === "HEAD")) {
    send(response, 200, "application/json; charset=utf-8", '{"status":"ok"}');
    return;
  }

  const now = new Date();
  if (path === "/api/health" && method === "GET") {
    sendJson(response, 200, { ok: true, ts: now.toISOString() });
    return;
  }
  if (path === "/api/scenes" && method === "GET") {
    sendJson(response, 200, deps.readModel());
    return;
  }
  if (path === "/api/progress" && method === "GET") {
    sendJson(response, 200, {
      generatedAt: now.toISOString(),
      progress: deps.progress ? deps.progress() : idleProgress(),
    });
    return;
  }
  if (path === "/api/sources" && method === "GET") {
    sendJson(response, 200, { generatedAt: now.toISOString(), sources: deps.store.listSources() });
    return;
  }
  if (path === "/api/runs" && method === "GET") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    sendJson(response, 200, { generatedAt: now.toISOString(), runs: deps.store.recentRuns(limit) });
    return;
  }
  if (path === "/api/refresh" && method === "POST") {
    const joined = deps.isBusy();
    const pending = deps.refresh();
    pending.catch((error) =>
      deps.log.error("refresh cycle failed", { error: (error as Error).message }),
    );
    sendJson(response, 202, {
      ok: true,
      status: joined ? "joined" : "started",
      refreshing: true,
    });
    return;
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(deps, path, response);
    return;
  }
  sendJson(response, 405, { error: "method not allowed" });
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer(createHttpHandler(deps));
}
