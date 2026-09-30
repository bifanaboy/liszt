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
import { isIP } from "node:net";

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
 *
 * `CF-Connecting-IP` needs the same scepticism, and for a sharper reason. The
 * throttle is a per-IP lockout, so the header's whole job is to choose the key
 * - and an attacker who can choose the key can always pick a fresh one, which
 * resets the counter. Validating the shape is therefore NECESSARY BUT NOT
 * SUFFICIENT: `/^[0-9a-f:.]{3,45}$/` accepted any hex-and-colon soup, and
 * `net.isIP` still accepts every syntactically valid address including ones the
 * attacker made up. What makes the header trustworthy is not its content, it is
 * WHO SENT IT.
 *
 * So the header is read only when the request actually arrived over loopback -
 * i.e. from the local Cloudflare connector, which is the only peer that can send
 * it and strip it from the public request. Any other peer is talking to the port
 * directly and is free to write the header itself, so it is ignored and the
 * socket address is used. That is also the right answer on Render, where there
 * is no tunnel and the socket address is the true client.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim().toLowerCase();
  if (!trimmed) return false;
  if (isIP(trimmed) === 4) return /^127\./.test(trimmed);
  // `::1`, plus the IPv4-mapped form Node reports for a v4 connection.
  return trimmed === "::1" || trimmed === "::ffff:127.0.0.1";
}

/**
 * Resolve the client IP. Exported separately from `clientIp` so the trust
 * decision is one function, and testable on its own.
 *
 * @param behindTrustedProxy Whether the request came from the local tunnel.
 *   Defaults to "the peer is loopback"; pass `true` only where that is known.
 */
export function resolveClientIp(
  headers: {
    "cf-connecting-ip"?: string | undefined;
    socket?: { remoteAddress?: string | undefined } | undefined;
  },
  behindTrustedProxy: boolean = isLoopbackAddress(headers.socket?.remoteAddress),
): string {
  const socketAddress = headers.socket?.remoteAddress;
  if (behindTrustedProxy) {
    const cf = headers["cf-connecting-ip"];
    if (typeof cf === "string") {
      // `isIP` returns 0 for anything that is not a complete, well-formed IPv4
      // or IPv6 address. It DOES accept a zone index (`fe80::1%eth0`), which is
      // a real address on the wire but two spellings of the same key to the
      // counter - so the value goes through the same normalisation as the
      // socket address below.
      const normalised = normaliseSocketAddress(cf);
      if (normalised !== "unknown") return normalised;
    }
  }
  // Fall back to the socket, normalised to a usable key. An `::ffff:` prefix or
  // a zone index would otherwise create distinct keys for one address, giving
  // the same client a fresh counter for each spelling.
  return normaliseSocketAddress(socketAddress);
}

/** Strip the IPv4-mapped prefix and any zone index; unknown peers stay unknown. */
function normaliseSocketAddress(address: string | undefined): string {
  if (typeof address !== "string") return "unknown";
  const trimmed = address.trim();
  if (!trimmed) return "unknown";
  const withoutZone = trimmed.split("%")[0] as string;
  if (!withoutZone) return "unknown";
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(withoutZone);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  return isIP(withoutZone) !== 0 ? withoutZone : "unknown";
}

export function clientIp(headers: {
  "cf-connecting-ip"?: string | undefined;
  socket?: { remoteAddress?: string | undefined } | undefined;
}): string {
  return resolveClientIp(headers);
}
