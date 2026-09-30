/**
 * The HTTP surface. Plain `node:http`, no framework: the route table is small
 * and the auth wrapper is the only cross-cutting concern.
 *
 * Everything is gated except `GET /login`, `POST /login`, and the login page's
 * own assets. `/api/health` is gated too: a public liveness endpoint tells a
 * scanner exactly what is running, and it is not evidence that the sources are
 * healthy.
 *
 * All responses are `no-store`, so the Cloudflare edge never caches the
 * catalogue, and static serving is path-traversal safe by construction: the
 * resolved target must stay inside `publicDir`.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import {
  authenticate,
  attemptLogin,
  isPublicPath,
  unauthenticatedResponse,
} from "../auth/middleware.ts";
import { clearSessionCookie, sessionCookie, type SessionService } from "../auth/session.ts";
import type { LoginThrottle } from "../auth/throttle.ts";
import { clientIp } from "../auth/throttle.ts";
import type { Config } from "../config.ts";
import type { Logger } from "../core/logger.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
import type { ReadModel } from "./read-model.ts";

const MAX_BODY_BYTES = 8 * 1024;
const DAY_SECONDS = 86_400;

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
  config: Config;
  store: SqliteStore;
  log: Logger;
  sessions: SessionService;
  throttle: LoginThrottle;
  /** Build the read model, including the current refreshing flag. */
  readModel: () => ReadModel;
  /** Start or join the single in-flight sync cycle. */
  refresh: () => Promise<unknown>;
  isBusy: () => boolean;
  publicDir: string;
  /** Set the `Secure` cookie attribute (true in production). */
  cookieSecure: boolean;
  /** Overridable so tests can count hash calls (throttle-before-hash). */
  verifyPassword: (password: string, stored: string | undefined) => Promise<boolean>;
}

function send(res: ServerResponse, status: number, contentType: string, body: string | Buffer): void {
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

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseCredentials(raw: string, contentType: string | undefined): Record<string, unknown> {
  const type = contentType ?? "";
  if (type.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw || "{}") as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(raw);
  const password = params.get("password");
  return password === null ? {} : { password };
}

/** Resolve a URL path to a file inside `publicDir`, or null on traversal. */
function staticTarget(publicDir: string, pathname: string): string | null {
  const root = resolve(publicDir);
  const relative =
    pathname === "/" ? "index.html" : pathname === "/login" ? "login.html" : pathname.replace(/^\/+/, "");
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
    send(res, 200, CONTENT_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream", body);
  } catch {
    send(res, 404, "text/plain; charset=utf-8", "not found\n");
  }
}

function loginPage(res: ServerResponse): void {
  // A tiny redirect-free page kept inline so a missing public/login.html still
  // yields a working splash rather than a 500.
  send(
    res,
    200,
    "text/html; charset=utf-8",
    `<!doctype html><html><head><meta charset="utf-8"><title>Liszt</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/login.css"></head><body>
<main class="login"><h1>Liszt</h1>
<form method="post" action="/login"><label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus>
<button type="submit">Enter</button></form>
<p class="error" role="alert"></p></main>
<script src="/login.js"></script></body></html>\n`,
  );
}

export function createHttpHandler(deps: HttpDeps): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    void handle(deps, request, response).catch((error) => {
      deps.log.error("request failed", { error: (error as Error).message });
      if (!response.headersSent) sendJson(response, 500, { error: "internal error" });
      else response.end();
    });
  };
}

async function handle(deps: HttpDeps, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const method = (request.method ?? "GET").toUpperCase();
  const url = new URL(request.url ?? "/", "http://localhost");
  const path = url.pathname;

  // `POST /login` is public and is handled first: `isPublicPath` also matches
  // `/login`, so checking the GET surface before this would shadow the form
  // submission with a static file lookup.
  if (path === "/login" && method === "POST") {
    await handleLogin(deps, request, response);
    return;
  }
  if (isPublicPath(method, path)) {
    if (path === "/login" && method === "GET") loginPage(response);
    else await serveStatic(deps, path, response);
    return;
  }

  const authEnabled = !deps.config.authDisabled;
  const now = new Date();
  const outcome = authEnabled
    ? authenticate(
        request,
        {
          sessions: deps.sessions,
          throttle: deps.throttle,
          passwordHash: deps.config.authPasswordHash,
          config: deps.config,
          verifyPassword: deps.verifyPassword,
        },
        now,
      )
    : { authenticated: true, token: null, ip: "local" };

  if (!outcome.authenticated) {
    unauthenticatedResponse(path, response);
    return;
  }

  if (path === "/logout" && method === "POST") {
    if (outcome.token) deps.sessions.revoke(outcome.token);
    response.writeHead(302, {
      location: "/login",
      "set-cookie": clearSessionCookie(deps.cookieSecure),
      "cache-control": "no-store",
    });
    response.end();
    return;
  }

  if (path === "/api/health" && method === "GET") {
    sendJson(response, 200, { ok: true, ts: now.toISOString() });
    return;
  }
  if (path === "/api/scenes" && method === "GET") {
    sendJson(response, 200, deps.readModel());
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
    pending.catch((error) => deps.log.error("refresh cycle failed", { error: (error as Error).message }));
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

async function handleLogin(
  deps: HttpDeps,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const raw = await readBody(request).catch(() => "");
  const body = parseCredentials(raw, request.headers["content-type"] as string | undefined);
  // The throttle is consulted inside attemptLogin BEFORE any scrypt work.
  const result = await attemptLogin(body.password, clientIpOf(request), {
    sessions: deps.sessions,
    throttle: deps.throttle,
    passwordHash: deps.config.authPasswordHash,
    config: deps.config,
    verifyPassword: deps.verifyPassword,
  }, new Date());

  if (!result.ok) {
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (result.retryAfterSeconds) headers["retry-after"] = String(result.retryAfterSeconds);
    response.writeHead(result.status, headers);
    response.end(JSON.stringify({ error: "invalid credentials" }));
    return;
  }
  response.writeHead(302, {
    location: "/",
    "set-cookie": sessionCookie(result.token as string, {
      maxAgeSeconds: deps.config.sessionTtlDays * DAY_SECONDS,
      secure: deps.cookieSecure,
    }),
    "cache-control": "no-store",
  });
  response.end();
}

function clientIpOf(request: IncomingMessage): string {
  return clientIp({
    "cf-connecting-ip": request.headers["cf-connecting-ip"] as string | undefined,
    socket: request.socket,
  });
}

export function createHttpServer(deps: HttpDeps): Server {
  return createServer(createHttpHandler(deps));
}