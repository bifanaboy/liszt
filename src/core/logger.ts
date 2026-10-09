/**
 * Structured JSON-line logging. Every pipeline step is inspectable after the
 * fact instead of leaving scattered console output behind.
 *
 * The logger NEVER throws. A `fields` value comes from parsed remote payloads,
 * so it can be a `BigInt`, a circular object, or a `toJSON` that throws - and a
 * logger that throws takes down whatever pipeline step called it, converting a
 * bad log field into a failed sync. Such a field is dropped and the entry is
 * still written; if even that fails, the line degrades to a fixed string.
 */
import { sanitizeErrorMessage } from "./sanitize-error.ts";
export type LogLevel = "debug" | "info" | "warn" | "error";

/** Keys the envelope owns. A field with one of these names is namespaced. */
const RESERVED_KEYS = ["ts", "level", "message"] as const;

/** Replace values `JSON.stringify` cannot handle: BigInt, cycles, throwing. */
function toJsonSafe(
  value: unknown,
  seen: Set<object>,
  depth = 0,
  secrets: readonly string[] = [],
): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sanitizeErrorMessage(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (depth > 6) return "[truncated]";
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    // `toJSON` first, the way `JSON.stringify` does it. A `Date` has no own
    // enumerable properties, so walking it as a plain object would log `{}` -
    // and losing a timestamp is exactly the kind of quiet degradation a log
    // line exists to prevent.
    const custom = (value as { toJSON?: unknown }).toJSON;
    if (typeof custom === "function") {
      return toJsonSafe((custom as () => unknown).call(value), seen, depth, secrets);
    }
    if (Array.isArray(value)) {
      return value.slice(0, 100).map((entry) => toJsonSafe(entry, seen, depth + 1, secrets));
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = toJsonSafe(entry, seen, depth + 1, secrets);
    }
    return out;
  } catch {
    return "[unserialisable]";
  } finally {
    seen.delete(value);
  }
}

/** Drop reserved keys from caller fields, so a field cannot rewrite the envelope. */
function withoutReserved(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if ((RESERVED_KEYS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export class JsonLogger implements Logger {
  private readonly base: Record<string, unknown>;
  private readonly sink: (line: string) => void;
  private readonly secrets: readonly string[];

  constructor(
    base: Record<string, unknown> = {},
    sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
    secrets: readonly string[] = [],
  ) {
    this.base = base;
    this.sink = sink;
    this.secrets = secrets;
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    let line: string;
    try {
      const seen = new Set<object>();
      const safeBase = toJsonSafe(this.base, seen, 0, this.secrets) as Record<string, unknown>;
      const safeFields = toJsonSafe(withoutReserved(fields ?? {}), seen, 0, this.secrets) as Record<
        string,
        unknown
      >;
      line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        message: sanitizeErrorMessage(message, this.secrets),
        ...safeBase,
        ...safeFields,
      });
    } catch {
      // Second line of defence: the safe walk above should have removed every
      // hazard, so reaching here means something unexpected. Still emit
      // something rather than throwing from a log call.
      line = JSON.stringify({ ts: new Date().toISOString(), level, message, fieldsError: true });
    }
    try {
      this.sink(line);
    } catch {
      /* A broken sink must not propagate into the pipeline. */
    }
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write("error", message, fields);
  }

  child(fields: Record<string, unknown>): Logger {
    return new JsonLogger({ ...this.base, ...fields }, this.sink, this.secrets);
  }
}

/** A logger that discards everything. The default in tests. */
export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  child(): Logger {
    return this;
  }
}
