import { test } from "node:test";
import assert from "node:assert/strict";
import { assertAuthConfigured, loadConfig } from "../src/config.ts";
import { hashPassword, parsePasswordHash, verifyPassword } from "../src/auth/password.ts";
import { createSessionService, SESSION_COOKIE, sessionCookie, tokenHash } from "../src/auth/session.ts";
import { LoginThrottle } from "../src/auth/throttle.ts";
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