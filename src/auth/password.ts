/**
 * The single shared password. No username, no external identity provider.
 *
 * Hash format: `scrypt$N$r$p$<salt-b64>$<hash-b64>`.
 *
 * The cost parameters live INSIDE the string, so raising them later does not
 * invalidate an existing deployment's hash - the new parameters simply apply
 * when the hash is next regenerated. That is the reason for encoding them at
 * all, so it is not optional decoration.
 *
 * The plaintext password is never stored, logged, or returned, and there is no
 * recovery path: losing the hash means resetting it with `npm run auth:hash`.
 */
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** Cost parameters. N=2^15 is ~100ms of CPU on a small VPS - the point of it. */
export const SCRYPT_PARAMS = Object.freeze({ N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

/** The one error a caller ever sees, so a wrong password is indistinguishable
 *  from a malformed request. */
export class AuthError extends Error {
  constructor() {
    super("Invalid credentials");
    this.name = "AuthError";
  }
}

function derive(
  password: string,
  salt: Buffer,
  N: number,
  r: number,
  p: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N, r, p, maxmem: SCRYPT_PARAMS.maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/** Hash a password for `LISZT_AUTH_PASSWORD_HASH`. */
export async function hashPassword(password: string): Promise<string> {
  if (!password) throw new Error("Refusing to hash an empty password");
  const { N, r, p } = SCRYPT_PARAMS;
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

export interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

/** Parse a stored hash, or return null when it is malformed. */
export function parsePasswordHash(value: string | undefined | null): ParsedHash | null {
  if (!value) return null;
  const parts = value.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return null;
  if (N > 1 << 20 || r > 32 || p > 16) return null;
  try {
    const salt = Buffer.from(parts[4] as string, "base64");
    const key = Buffer.from(parts[5] as string, "base64");
    if (!salt.length || key.length !== KEY_LENGTH) return null;
    return { N, r, p, salt, key };
  } catch {
    return null;
  }
}

/**
 * Verify a password against a stored hash. Returns false - never throws - for
 * a malformed hash, so a misconfigured deployment is a rejected login rather
 * than a stack trace. A caller that needs a misconfiguration to be loud should
 * check `parsePasswordHash` at boot, which is what the composition root does.
 */
export async function verifyPassword(
  password: string,
  stored: string | undefined | null,
): Promise<boolean> {
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  const actual = await derive(password, parsed.salt, parsed.N, parsed.r, parsed.p);
  // timingSafeEqual throws on a length mismatch; equal lengths are guaranteed
  // by parsePasswordHash, so this cannot throw here.
  return timingSafeEqual(actual, parsed.key);
}
