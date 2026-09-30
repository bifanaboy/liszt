/**
 * Sessions. 32 random bytes, DB-backed, sliding expiry.
 *
 * Only `sha256(token)` is persisted, so a leaked database (or a leaked backup)
 * cannot mint a session. The choice of a database over a stateless JWT is
 * deliberate: a leaked cookie must be revocable, and with 30 days of sliding
 * lifetime a stateless token would be a long-lived un-revocable credential.
 */
import { createHash, randomBytes } from "node:crypto";
import type { SqliteStore } from "../core/store/sqlite.ts";

export const SESSION_COOKIE = "liszt_session";
const TOKEN_BYTES = 32;
const DAY_MS = 86_400_000;

export interface CookieOptions {
  maxAgeSeconds: number;
  secure: boolean;
}

/**
 * The cookie attributes. `SameSite=Lax` plus POST-only login/logout is the CSRF
 * defence: a cross-site request carries no cookie, so it cannot mutate anything.
 * This also covers `POST /api/refresh`, the only other mutating endpoint.
 */
export function sessionCookie(token: string, { maxAgeSeconds, secure }: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** The raw token is the credential; only its digest is ever stored. */
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface SessionService {
  issue(now: Date): { token: string; expiresAt: string };
  /** Validate a raw cookie value and slide its expiry. */
  verify(token: string, now: Date): boolean;
  revoke(token: string): void;
  /** Housekeeping; the scheduler calls this on boot and hourly. */
  purge(now: Date): number;
}

export function createSessionService(
  store: SqliteStore,
  { ttlDays = 30 }: { ttlDays?: number } = {},
): SessionService {
  const ttlMs = ttlDays * DAY_MS;
  return {
    issue(now) {
      const token = randomBytes(TOKEN_BYTES).toString("base64url");
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      store.createSession(tokenHash(token), now.toISOString(), expiresAt);
      return { token, expiresAt };
    },
    verify(token, now) {
      if (!token) return false;
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      return store.touchSession(tokenHash(token), now.toISOString(), expiresAt);
    },
    revoke(token) {
      if (token) store.deleteSession(tokenHash(token));
    },
    purge(now) {
      return store.purgeExpiredSessions(now.toISOString());
    },
  };
}

/**
 * Read the session token out of a `Cookie` header.
 *
 * The decode is guarded because a cookie value is CLIENT-SUPPLIED and
 * `decodeURIComponent` throws a `URIError` on a malformed percent escape - so
 * a request carrying `liszt_session=%` took the whole handler down with an
 * uncaught throw, turning a bad cookie into a 500 on every request that carried
 * one. A value that will not decode is treated as absent: there is no
 * legitimate session token that is not valid percent-encoding, and "no
 * session" is the correct reading of a corrupt one.
 */
export function readCookie(header: string | undefined, name = SESSION_COOKIE): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // Keep scanning: a duplicate header can still carry a usable value.
      continue;
    }
  }
  return null;
}
