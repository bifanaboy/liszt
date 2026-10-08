export const DEFAULT_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export class FetchError extends Error {
  constructor(message, kind, status) {
    super(message);
    this.name = "FetchError";
    this.kind = kind;
    this.status = status;
  }
}

export function classifyStatus(status) {
  return status === 404 || status === 410 ? "definitive" : "inconclusive";
}

export function classifyError(error) {
  return error instanceof FetchError ? error.kind : "inconclusive";
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "<invalid URL>";
  }
}

export class HttpFetcher {
  constructor(
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = USER_AGENT,
    fetchImpl = globalThis.fetch,
  ) {
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.userAgent = userAgent;
    this.fetchImpl = fetchImpl;
  }

  async fetch(url, options = {}) {
    const requested = options.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutMs =
      Number.isFinite(requested) && requested > 0 ? requested : this.defaultTimeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    let callerAborted = false;
    const abortFromCaller = () => {
      callerAborted = true;
      controller.abort(options.signal?.reason);
    };
    options.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (options.signal?.aborted) abortFromCaller();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await this.fetchImpl(url, {
        method: options.method ?? "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": this.userAgent, ...(options.headers ?? {}) },
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (error) {
      const target = safeUrl(url);
      if (callerAborted)
        throw new FetchError(`request to ${target} was aborted by the caller`, "inconclusive");
      if (timedOut)
        throw new FetchError(`request to ${target} timed out after ${timeoutMs}ms`, "inconclusive");
      const kind = error instanceof Error && error.name ? error.name : "network error";
      throw new FetchError(`request to ${target} failed (${kind})`, "inconclusive");
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
    }
  }

  async #ok(url, options = {}) {
    const response = await this.fetch(url, options);
    const target = safeUrl(url);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      const next = location ? safeUrl(new URL(location, url).href) : "";
      throw new FetchError(
        `GET ${target} -> ${response.status}${next ? ` -> ${next}` : ""}`,
        "inconclusive",
        response.status,
      );
    }
    if (!response.ok) {
      throw new FetchError(
        `GET ${target} -> ${response.status}`,
        classifyStatus(response.status),
        response.status,
      );
    }
    return response;
  }

  async text(url, options = {}) {
    return (await this.#ok(url, options)).text();
  }

  async json(url, options = {}) {
    try {
      return await (await this.#ok(url, options)).json();
    } catch (error) {
      if (error instanceof FetchError) throw error;
      throw new FetchError(`GET ${safeUrl(url)} returned invalid JSON`, "inconclusive");
    }
  }
}
