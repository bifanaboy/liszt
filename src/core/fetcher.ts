/**
 * A fetch layer with real failure semantics. Every request carries a timeout,
 * an outer abort signal propagates, and errors are classified into the exact
 * "definitive vs inconclusive" split the link re-verify spec depends on.
 *
 * The classification is the whole point: a 404/410 means the resource does not
 * exist, which is a re-verify strike, while a timeout, a 403 anti-bot wall, or
 * a 5xx means "ask again later" and must not count against a link.
 */
import type { Fetcher, FetchOptions } from "../sources/types.ts";

export type FetchClass = "definitive" | "inconclusive";

export class FetchError extends Error {
  readonly kind: FetchClass;
  readonly status: number | undefined;

  constructor(message: string, kind: FetchClass, status?: number) {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
    this.status = status;
  }
}

export const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * A 404/410 is definitive (the resource does not exist). Everything else -
 * including 403 anti-bot walls, 429 throttling, and 5xx - is inconclusive.
 */
export function classifyStatus(status: number): FetchClass {
  if (status === 404 || status === 410) return "definitive";
  return "inconclusive";
}

/** Read the classification off an arbitrary error, defaulting to inconclusive. */
export function classifyError(error: unknown): FetchClass {
  return error instanceof FetchError ? error.kind : "inconclusive";
}

const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class HttpFetcher implements Fetcher {
  private readonly defaultTimeoutMs: number;
  private readonly userAgent: string;

  constructor(
    defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS,
    userAgent: string = BROWSER_USER_AGENT,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.userAgent = userAgent;
  }

  async fetch(url: string, options: FetchOptions = {}): Promise<Response> {
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const init: RequestInit = {
      method: options.method ?? "GET",
      // A studio listing that answers a non-browser user agent with a 403 is a
      // source outage, not a reason to emit partial scenes.
      redirect: "manual",
      signal,
      headers: { "user-agent": this.userAgent, ...(options.headers ?? {}) },
    };
    if (options.body !== undefined) init.body = options.body;
    try {
      return await globalThis.fetch(url, init);
    } catch (error) {
      const name = (error as { name?: string }).name;
      const message =
        name === "TimeoutError" || name === "AbortError"
          ? `request to ${url} timed out after ${timeoutMs}ms`
          : `request to ${url} failed: ${(error as Error).message}`;
      throw new FetchError(message, "inconclusive");
    }
  }

  /** Throw on any 3xx. Callers that follow redirects handle them explicitly. */
  private async ok(url: string, options: FetchOptions): Promise<Response> {
    const response = await this.fetch(url, options);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      throw new FetchError(
        `GET ${url} -> ${response.status}${location ? ` -> ${location}` : ""}`,
        "inconclusive",
        response.status,
      );
    }
    if (!response.ok) {
      throw new FetchError(
        `GET ${url} -> ${response.status}`,
        classifyStatus(response.status),
        response.status,
      );
    }
    return response;
  }

  async text(url: string, options: FetchOptions = {}): Promise<string> {
    return (await this.ok(url, options)).text();
  }

  async json<T = unknown>(url: string, options: FetchOptions = {}): Promise<T> {
    const response = await this.ok(url, options);
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new FetchError(
        `GET ${url} returned invalid JSON: ${(error as Error).message}`,
        "inconclusive",
      );
    }
  }
}
