/**
 * The per-IP login throttle.
 *
 * This exists because `scrypt` is DELIBERATELY CPU-expensive. A public
 * `POST /login` pushed through a Cloudflare tunnel is therefore a
 * denial-of-service vector, not merely a guessing risk: an attacker can make
 * the box burn a full core per request. So the counter is consulted BEFORE any
 * hash work, and a locked-out request never reaches `scrypt` at all. The
 * `middleware.ts` ordering and the auth test assert that coupling.
 *
 * Successful requests count too. A locked-out IP is refused before its password
 * is even checked, so "guess correctly while locked out" is not a bypass.
 *
 * State is an in-memory Map with periodic sweeping: this is a single process.
 * Running more than one instance requires moving this counter to the database.
 */

export interface ThrottleOptions {
  /** Consecutive failures that trigger a lockout. */
  maxFailures: number;
  /** How long a lockout lasts. */
  lockoutMinutes: number;
  /** Injected clock so tests do not have to sleep. */
  now: () => number;
  /** Bound the map so a rotating-IP attack cannot grow it without limit. */
  maxEntries?: number;
}

export interface ThrottleVerdict {
  allowed: boolean;
  /** Seconds until the lockout lifts. Meaningful only when `allowed` is false. */
  retryAfterSeconds: number;
  /** Consecutive failures recorded for this IP. */
  failures: number;
}

interface Entry {
  failures: number;
  lockedUntil: number;
  lastSeen: number;
}

const DEFAULT_MAX_ENTRIES = 4096;
const LOCKOUT_MS = 60_000;

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly maxFailures: number;
  private readonly lockoutMs: number;
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor({ maxFailures, lockoutMinutes, now, maxEntries = DEFAULT_MAX_ENTRIES }: ThrottleOptions) {
    this.maxFailures = maxFailures;
    this.lockoutMs = lockoutMinutes * 60_000;
    this.now = now;
    this.maxEntries = maxEntries;
  }

  /**
   * Consult the counter. This MUST be called before any `scrypt` work: a
   * `false` verdict means the request is refused without hashing.
   */
  check(ip: string): ThrottleVerdict {
    const at = this.now();
    const entry = this.entries.get(ip);
    if (!entry) return { allowed: true, retryAfterSeconds: 0, failures: 0 };
    if (entry.lockedUntil > at) {
      entry.lastSeen = at;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.lockedUntil - at) / 1000)),
        failures: entry.failures,
      };
    }
    // The lockout has expired; a stale counter starts clean rather than
    // immediately re-locking on one more failure.
    if (entry.lockedUntil > 0) {
      this.entries.delete(ip);
      return { allowed: true, retryAfterSeconds: 0, failures: 0 };
    }
    entry.lastSeen = at;
    return { allowed: true, retryAfterSeconds: 0, failures: entry.failures };
  }

  /** A correct password clears the IP's counter. */
  recordSuccess(ip: string): void {
    this.entries.delete(ip);
  }

  /** A wrong password (or a malformed body) counts. */
  recordFailure(ip: string): void {
    const at = this.now();
    const entry = this.entries.get(ip) ?? { failures: 0, lockedUntil: 0, lastSeen: at };
    entry.failures += 1;
    entry.lastSeen = at;
    if (entry.failures >= this.maxFailures) {
      entry.lockedUntil = at + this.lockoutMs;
      entry.failures = 0;
    }
    this.entries.set(ip, entry);
    if (this.entries.size > this.maxEntries) this.evictOldest();
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.lastSeen < oldestAt) {
        oldestAt = entry.lastSeen;
        oldestKey = key;
      }
    }
    if (oldestKey !== undefined) this.entries.delete(oldestKey);
  }

  /** Drop entries no longer relevant. The scheduler calls this periodically. */
  sweep(): number {
    const at = this.now();
    let removed = 0;
    for (const [key, entry] of this.entries) {
      const expired = entry.lockedUntil > 0 && entry.lockedUntil <= at;
      const idle = at - entry.lastSeen > LOCKOUT_MS * 60;
      if (expired || idle) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * The client IP. Behind a Cloudflare tunnel the socket address is always
 * `127.0.0.1`, so the real client is only available from `CF-Connecting-IP`.
 * No other client-supplied header is trusted: `X-Forwarded-For` is
 * attacker-controlled and would let anyone reset their own counter by sending
 * a fresh value on every request.
 */
export function clientIp(headers: {
  "cf-connecting-ip"?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}): string {
  const cf = headers["cf-connecting-ip"];
  if (typeof cf === "string") {
    const trimmed = cf.trim();
    if (/^[0-9a-f:.]{3,45}$/i.test(trimmed)) return trimmed;
  }
  return headers.socket?.remoteAddress ?? "unknown";
}
