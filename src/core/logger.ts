/**
 * Structured JSON-line logging. Every pipeline step is inspectable after the
 * fact instead of leaving scattered console output behind.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

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

  constructor(
    base: Record<string, unknown> = {},
    sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
  ) {
    this.base = base;
    this.sink = sink;
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    this.sink(
      JSON.stringify({ ts: new Date().toISOString(), level, message, ...this.base, ...fields }),
    );
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
    return new JsonLogger({ ...this.base, ...fields }, this.sink);
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
