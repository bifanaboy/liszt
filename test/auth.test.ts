import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAuthConfigured, loadConfig } from "../src/config.ts";
import {
  hashPassword,
  parsePasswordHash,
  scryptMemoryBytes,
  verifyPassword,
  SCRYPT_MAXMEM_CEILING,
  SCRYPT_PARAMS,
} from "../src/auth/password.ts";
import { createSessionService, readCookie, SESSION_COOKIE, sessionCookie, tokenHash } from "../src/auth/session.ts";
import { clientIp, LoginThrottle } from "../src/auth/throttle.ts";
import { attemptLogin, type AuthDeps } from "../src/auth/middleware.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";

function freshStore(): SqliteStore {
  const store = new SqliteStore(":memory:");
  store.migrate();
  return store;
}

test("the password hash round-trips and rejects a wrong password", async () => {
  const hash = await hashPassword("correct horse battery staple");
  assert.ok(parsePasswordHash(hash));
  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("only sha256(token) is stored, never the raw token", () => {
  const raw = "a-raw-token";
  const digest = tokenHash(raw);
  assert.equal(digest.length, 64);
  assert.notEqual(digest, raw);
  assert.match(digest, /^[0-9a-f]{64}$/);
});

test("sessions issue, slide on verify, revoke, and expire", () => {
  const store = freshStore();
  const sessions = createSessionService(store, { ttlDays: 30 });
  const t0 = new Date("2026-03-01T00:00:00Z");
  const { token } = sessions.issue(t0);
  assert.equal(sessions.verify(token, new Date("2026-03-10T00:00:00Z")), true);
  assert.equal(sessions.verify("forged", t0), false);
  sessions.revoke(token);
  assert.equal(sessions.verify(token, t0), false);

  const { token: second } = sessions.issue(t0);
  // Never touched since issue: 31 days later it must be gone.
  assert.equal(sessions.verify(second, new Date("2026-04-01T00:00:00Z")), false);
  store.close();
});

test("a locked-out IP is refused BEFORE any scrypt work", async () => {
  const store = freshStore();
  const sessions = createSessionService(store);
  let clock = 1_000_000;
  const throttle = new LoginThrottle({ maxFailures: 1, lockoutMinutes: 15, now: () => clock });
  let hashCalls = 0;
  const deps: AuthDeps = {
    sessions,
    throttle,
    passwordHash: "scrypt$..." /* intentionally unusable: verifyPassword is stubbed */,
    config: loadConfig({}),
    verifyPassword: async () => {
      hashCalls += 1;
      return false;
    },
  };

  const first = await attemptLogin("wrong", "203.0.113.7", deps, new Date(clock));
  assert.equal(first.status, 401);
  assert.equal(hashCalls, 1);

  const second = await attemptLogin("wrong", "203.0.113.7", deps, new Date(clock));
  assert.equal(second.status, 429);
  assert.ok(second.retryAfterSeconds && second.retryAfterSeconds > 0);
  // The whole point: no further hashing happened while locked out.
  assert.equal(hashCalls, 1);

  // After the lockout lapses the counter is cleared.
  clock += 16 * 60_000;
  const third = await attemptLogin("wrong", "203.0.113.7", deps, new Date(clock));
  assert.equal(third.status, 401);
  assert.equal(hashCalls, 2);
  store.close();
});

test("a malformed body is indistinguishable from a wrong password", async () => {
  const store = freshStore();
  const sessions = createSessionService(store);
  let hashCalls = 0;
  const deps: AuthDeps = {
    sessions,
    throttle: new LoginThrottle({ maxFailures: 10, lockoutMinutes: 15, now: () => 0 }),
    passwordHash: "whatever",
    config: loadConfig({}),
    verifyPassword: async () => {
      hashCalls += 1;
      return false;
    },
  };
  const malformed = await attemptLogin(undefined, "198.51.100.9", deps, new Date(0));
  const wrong = await attemptLogin("wrong", "198.51.100.9", deps, new Date(0));
  assert.equal(malformed.status, wrong.status);
  // A non-string password never reaches the hash function at all.
  assert.equal(hashCalls, 1);
  store.close();
});

test("a successful login issues a session and sets the cookie attributes", async () => {
  const store = freshStore();
  const sessions = createSessionService(store);
  const hash = await hashPassword("a-long-enough-password");
  const deps: AuthDeps = {
    sessions,
    throttle: new LoginThrottle({ maxFailures: 10, lockoutMinutes: 15, now: () => 0 }),
    passwordHash: hash,
    config: loadConfig({}),
    verifyPassword,
  };
  const result = await attemptLogin("a-long-enough-password", "203.0.113.1", deps, new Date(0));
  assert.equal(result.ok, true);
  assert.ok(result.token);
  const cookie = sessionCookie(result.token as string, { maxAgeSeconds: 60, secure: true });
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Secure/);
  store.close();
});

test("the server refuses to start without a hash in production", () => {
  const config = loadConfig({});
  assert.throws(() => assertAuthConfigured(config, { NODE_ENV: "production" }));
  assert.doesNotThrow(() => assertAuthConfigured(config, { NODE_ENV: "development" }));
  const withHash = loadConfig({ LISZT_AUTH_PASSWORD_HASH: "scrypt$1$1$1$AA$AA" });
  assert.doesNotThrow(() => assertAuthConfigured(withHash, { NODE_ENV: "production" }));
  const disabled = loadConfig({ LISZT_AUTH_DISABLED: "true", LISZT_AUTH_PASSWORD_HASH: "x" });
  assert.throws(() => assertAuthConfigured(disabled, { NODE_ENV: "production" }));
});

test("boolean env values are parsed strictly, not by anything-not-true", () => {
  // The old rule was `value === "1" || value === "true"`, so `yes`, `on` and
  // `treu` all silently became FALSE. For LISZT_BOOT_SYNC that is invisible; for
  // LISZT_AUTH_DISABLED it flips the meaning of the flag entirely.
  assert.equal(loadConfig({ LISZT_BOOT_SYNC: "1" }).bootSync, true);
  assert.equal(loadConfig({ LISZT_BOOT_SYNC: "true" }).bootSync, true);
  assert.equal(loadConfig({ LISZT_BOOT_SYNC: "TRUE" }).bootSync, true);
  assert.equal(loadConfig({ LISZT_BOOT_SYNC: " yes " }).bootSync, true);
  assert.equal(loadConfig({ LISZT_BOOT_SYNC: "0" }).bootSync, false);
  assert.equal(loadConfig({ LISZT_BOOT_SYNC: "no" }).bootSync, false);
  assert.equal(loadConfig({ LISZT_BOOT_SYNC: "off" }).bootSync, false);
  assert.throws(() => loadConfig({ LISZT_BOOT_SYNC: "treu" }), /LISZT_BOOT_SYNC/);
  assert.throws(() => loadConfig({ LISZT_AUTH_DISABLED: "maybe" }), /LISZT_AUTH_DISABLED/);
  assert.throws(() => loadConfig({ LISZT_LOG_STDERR: "2" }), /LISZT_LOG_STDERR/);
  // Unset still means the default, not an error.
  assert.equal(loadConfig({}).bootSync, true);
});

test("the client IP is only taken from the header when the tunnel sent it", () => {
  // The header chooses the throttle's key, so an attacker who can send it can
  // pick a fresh key on every request and never accumulate a lockout. Shape
  // validation alone does not help - every address the attacker invents is
  // well-formed. The trust comes from WHO SENT IT: only the local Cloudflare
  // connector can, and it only appears on a loopback peer.
  const fromTunnel = { "cf-connecting-ip": "203.0.113.7", socket: { remoteAddress: "127.0.0.1" } };
  assert.equal(clientIp(fromTunnel), "203.0.113.7");
  assert.equal(clientIp({ ...fromTunnel, socket: { remoteAddress: "::1" } }), "203.0.113.7");

  // Direct to the port: the peer is the client, and the header is theirs to lie about.
  assert.equal(
    clientIp({ "cf-connecting-ip": "198.51.100.1", socket: { remoteAddress: "203.0.113.9" } }),
    "203.0.113.9",
  );

  // Shape validation, for the trusted path: the old regex accepted hex soup.
  assert.equal(clientIp({ "cf-connecting-ip": "deadbeef", socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  assert.equal(clientIp({ "cf-connecting-ip": "1.2.3", socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  assert.equal(clientIp({ "cf-connecting-ip": "::1", socket: { remoteAddress: "127.0.0.1" } }), "::1");
  // A zone index is a real address on the wire, but two spellings of one key.
  assert.equal(clientIp({ "cf-connecting-ip": "fe80::1%eth0", socket: { remoteAddress: "127.0.0.1" } }), "fe80::1");
  assert.equal(clientIp({ socket: { remoteAddress: "127.0.0.1" } }), "127.0.0.1");
  assert.equal(clientIp({}), "unknown");
  assert.equal(clientIp({ socket: { remoteAddress: "not-an-ip" } }), "unknown");

  // One address, one key: `::ffff:` and a zone index must not mint a fresh
  // counter for the same client.
  assert.equal(
    clientIp({ socket: { remoteAddress: "::ffff:203.0.113.9" } }),
    "203.0.113.9",
  );
  assert.equal(clientIp({ socket: { remoteAddress: "fe80::1%eth0" } }), "fe80::1");
});

test("a malformed cookie is no session, not a 500", () => {
  // `decodeURIComponent` throws on a bad percent escape, and a cookie is
  // client-supplied - so `%` used to take the request handler down.
  assert.equal(readCookie(`${SESSION_COOKIE}=%`, SESSION_COOKIE), null);
  assert.equal(readCookie(`${SESSION_COOKIE}=%E0%A4%A`, SESSION_COOKIE), null);
  assert.equal(readCookie(`${SESSION_COOKIE}=abc%`, SESSION_COOKIE), null);
  assert.equal(readCookie(`other=1; ${SESSION_COOKIE}=%zz; more=2`), null);
  // A usable duplicate later in the header is still found.
  assert.equal(readCookie(`${SESSION_COOKIE}=%; ${SESSION_COOKIE}=good-token`), "good-token");
  assert.equal(readCookie(`${SESSION_COOKIE}=good-token`), "good-token");
  assert.equal(readCookie(undefined), null);
  assert.equal(readCookie("nothing-here"), null);
});

test("a scrypt hash whose cost exceeds the memory ceiling is rejected, not thrown on", async () => {
  // The stored hash carries its own cost parameters, and the old parser accepted
  // N up to 2^20 with r up to 32 - 4 GiB against a 64 MiB budget. `scrypt`
  // throws in that case, so `verifyPassword` threw instead of returning false
  // and the login endpoint answered 500 instead of 401.
  const impossible = "scrypt$1048576$32$1$c2FsdHNhbHRzYWx0c2E$" + Buffer.alloc(32).toString("base64");
  assert.equal(parsePasswordHash(impossible), null, "rejected at parse, so a boot check stays meaningful");
  assert.equal(await verifyPassword("anything", impossible), false);
  // The shipped parameters are comfortably inside the ceiling.
  assert.ok(scryptMemoryBytes(SCRYPT_PARAMS.N, SCRYPT_PARAMS.r, SCRYPT_PARAMS.p) <= SCRYPT_MAXMEM_CEILING);
  assert.equal(await verifyPassword("nope", "scrypt$0$8$1$c2FsdA$AA"), false);
  assert.equal(await verifyPassword("nope", "scrypt$8$8$1$c2FsdA$AA"), false);
});