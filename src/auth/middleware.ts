/**
 * The HTTP auth wrapper.
 *
 * Coverage: everything is gated EXCEPT `GET /login` and its assets, and
 * `GET /health`. `/api/health` is gated - it reports store and source state -
 * while `/health` is a bare liveness probe: a fixed 200 with a constant body,
 * no data about what is running. That is the whole of what a platform health
 * check needs, and it answers a question no scanner can extract value from.
 *
 * Responses: an unauthenticated `/` redirects to `/login`; an unauthenticated
 * `/api/*` returns JSON 401 so the UI can tell "session expired" from
 * "server down" instead of showing a JSON parse error.
 */
import { clientIp, type LoginThrottle } from "./throttle.ts";
import { readCookie, SESSION_COOKIE, type SessionService } from "./session.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.ts";

export interface AuthDeps {
  sessions: SessionService;
  throttle: LoginThrottle;
  passwordHash: string | undefined;
  config: Config;
  /** The one function that must not run on a locked-out request. */
  verifyPassword(password: string, stored: string | undefined): Promise<boolean>;
}

export interface AuthOutcome {
  /** True when the request may proceed without a login. */
  authenticated: boolean;
  /** The raw session token, when one was presented. */
  token: string | null;
  ip: string;
}

const LOGIN_ASSETS = new Set(["/login.css", "/login.js", "/favicon.ico"]);

/** The unauthenticated liveness probe, and the platform health-check path. */
export const HEALTH_PATH = "/health";

/** True when a path is reachable without a session. */
export function isPublicPath(method: string, path: string): boolean {
  if (path === "/login") return true;
  if (method !== "GET" && method !== "HEAD") return false;
  return LOGIN_ASSETS.has(path) || path === HEALTH_PATH;
}

/**
 * Decide whether a request is authenticated, sliding the session expiry on a
 * hit. Deliberately does no hashing - the caller decides when `scrypt` runs.
 */
export function authenticate(
  request: IncomingMessage,
  deps: AuthDeps,
  now: Date,
): AuthOutcome {
  const ip = clientIp({
    "cf-connecting-ip": request.headers["cf-connecting-ip"] as string | undefined,
    socket: request.socket,
  });
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (!token) return { authenticated: false, token: null, ip };
  // An unset hash means auth is disabled: trust nothing, and never issue a
  // session. The composition root refuses to boot in that state in production.
  if (!deps.passwordHash) return { authenticated: false, token: null, ip };
  const authenticated = deps.sessions.verify(token, now);
  return { authenticated, token, ip };
}

/** The unauthenticated response for a path. */
export function unauthenticatedResponse(path: string, response: ServerResponse): void {
  if (path.startsWith("/api/")) {
    const payload = JSON.stringify({ error: "unauthorized" });
    response.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    response.end(payload);
    return;
  }
  response.writeHead(302, { location: "/login", "cache-control": "no-store" });
  response.end();
}

export interface LoginResult {
  ok: boolean;
  /** 429 when locked out; 401 for every other rejection. */
  status: number;
  retryAfterSeconds?: number;
  token?: string;
}

/**
 * Attempt a login.
 *
 * The ordering here is the security property, and it is asserted in
 * `test/auth.test.ts`: `throttle.check` runs FIRST and a non-allowed verdict
 * returns without ever calling `verifyPassword`. A wrong password and a
 * malformed body produce the same status and the same body.
 */
export async function attemptLogin(
  password: unknown,
  ip: string,
  deps: AuthDeps,
  now: Date,
): Promise<LoginResult> {
  const verdict = deps.throttle.check(ip);
  if (!verdict.allowed) {
    return { ok: false, status: 429, retryAfterSeconds: verdict.retryAfterSeconds };
  }
  const usable = typeof password === "string" && password.length > 0 && password.length <= 1024;
  const valid = usable
    ? await deps.verifyPassword(password, deps.passwordHash)
    : false;
  if (!valid) {
    deps.throttle.recordFailure(ip);
    return { ok: false, status: 401 };
  }
  deps.throttle.recordSuccess(ip);
  const issued = deps.sessions.issue(now);
  return { ok: true, status: 200, token: issued.token };
}
