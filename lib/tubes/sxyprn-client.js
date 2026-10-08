import { validSxyprnUrl } from "./sxyprn.js";

export function durationStringToSeconds(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const numbers = parts.map(Number);
  if (numbers.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return numbers.reduce((total, part) => total * 60 + part, 0);
}

function durationSecondsOf(video) {
  if (Number.isFinite(video.durationSeconds)) return video.durationSeconds;
  return durationStringToSeconds(video.duration);
}

async function readRelayBody(response) {
  const maxBytes = 65_536;
  const advertisedBytes = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(advertisedBytes) && advertisedBytes > maxBytes) {
    await response.body?.cancel?.().catch(() => {});
    throw new Error("sxyprn relay response exceeded the size limit");
  }
  if (!response.body?.getReader) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error("sxyprn relay response exceeded the size limit");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("sxyprn relay response exceeded the size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createSxyprnRelayApi({ url, secret, fetchImpl = fetch, timeoutMs = 15_000 }) {
  const base = new URL(url);
  if (base.protocol !== "https:") throw new Error("Sxyprn relay URL must use HTTPS");
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("Sxyprn relay URL must be a plain HTTPS origin");
  }
  if (!secret) throw new Error("Sxyprn relay secret is required");

  const post = async (path, input) => {
    const response = await fetchImpl(new URL(`/v1/${path}`, base), {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`sxyprn relay returned HTTP ${response.status}`);
    try {
      return JSON.parse(await readRelayBody(response));
    } catch (error) {
      if (/size limit/.test(error.message)) throw error;
      throw new Error("sxyprn relay returned invalid JSON", { cause: error });
    }
  };

  return {
    videos: {
      search: async (query) => {
        const page = await post("search", { query });
        if (!Array.isArray(page.videos))
          throw new Error("sxyprn relay returned an invalid search result");
        return page;
      },
      details: async ({ url: postUrl }) => {
        if (!validSxyprnUrl(postUrl)) throw new Error("Sxyprn post URL is invalid");
        const detail = await post("details", { url: postUrl });
        if (!detail || typeof detail !== "object" || Array.isArray(detail)) {
          throw new Error("sxyprn relay returned an invalid post detail");
        }
        return detail;
      },
    },
  };
}

export function createSxyprnClient(api, options = {}) {
  const {
    timeoutMs = 15_000,
    maxConsecutiveFailures = 2,
    failureWindow = 10,
    failureRatio = 0.5,
    cooldownMs = 10 * 60_000,
  } = options;
  if (!Number.isFinite(failureWindow))
    throw new RangeError("failureWindow must be a finite number");
  const windowSize = Math.max(1, Math.floor(failureWindow));
  if (!Number.isFinite(failureRatio)) throw new RangeError("failureRatio must be a finite number");
  const minFailures = Math.max(1, Math.ceil(windowSize * failureRatio));
  let consecutiveFailures = 0;
  let broken = false;
  let openedAt = 0;
  let probing = false;
  let lastError = new Error("sxyprn unavailable");
  const outcomes = [];
  let queue = Promise.resolve();
  const requests = { search: 0, details: 0 };
  const failures = () => outcomes.reduce((total, ok) => total + (ok ? 0 : 1), 0);
  const record = (ok) => {
    outcomes.push(ok);
    if (outcomes.length > windowSize) outcomes.shift();
    return outcomes.length >= windowSize && failures() >= minFailures;
  };
  const clear = () => {
    consecutiveFailures = 0;
    broken = false;
    probing = false;
    openedAt = 0;
    outcomes.length = 0;
  };
  const openError = () =>
    new Error(
      `sxyprn circuit open (${failures()} of ${outcomes.length} recent calls failed); last: ${lastError.message}`,
    );
  const trip = (error) => {
    lastError = error instanceof Error ? error : new Error(String(error));
    if (probing) {
      probing = false;
      broken = true;
      openedAt = Date.now();
      return;
    }
    consecutiveFailures += 1;
    const unhealthy = record(false);
    if (consecutiveFailures >= maxConsecutiveFailures || unhealthy) {
      broken = true;
      openedAt = Date.now();
    }
  };
  const withDeadline = async (call, label) => {
    let timer;
    let pending;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`sxyprn ${label} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });
    try {
      requests[label] += 1;
      pending = call();
      const value = await Promise.race([pending, deadline]);
      if (probing) clear();
      else {
        consecutiveFailures = 0;
        record(true);
      }
      return value;
    } catch (error) {
      pending?.catch(() => {});
      trip(error);
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const guard = () => {
    if (!broken) return;
    if (Date.now() - openedAt < cooldownMs || probing) throw openError();
    probing = true;
  };
  const shut = () => broken && (Date.now() - openedAt < cooldownMs || probing);
  const inSlot = async (label, call) => {
    if (shut()) throw openError();
    const ahead = queue;
    let release;
    queue = new Promise((resolve) => {
      release = resolve;
    });
    await ahead;
    try {
      guard();
      return await withDeadline(call, label);
    } finally {
      release();
    }
  };

  return {
    videos: {
      search: async (query) => {
        const page = await inSlot("search", () => api.videos.search(query, { page: 0 }));
        return {
          videos: (page.videos ?? []).map((video) => {
            const durationSeconds = durationSecondsOf(video);
            return {
              ...(video.url !== undefined ? { url: video.url } : {}),
              ...(video.title !== undefined ? { title: video.title } : {}),
              ...(durationSeconds !== null ? { durationSeconds } : {}),
              ...(video.views !== undefined ? { views: video.views } : {}),
              ...(video.isExternal !== undefined ? { isExternal: video.isExternal } : {}),
              ...(video.author !== undefined ? { author: video.author } : {}),
            };
          }),
        };
      },
      details: async ({ url }) => {
        const detail = await inSlot("details", () => api.videos.details({ url }));
        const durationSeconds = durationSecondsOf(detail);
        return {
          ...(detail.url !== undefined ? { url: detail.url } : {}),
          ...(detail.title !== undefined ? { title: detail.title } : {}),
          ...(durationSeconds !== null ? { durationSeconds } : {}),
          ...(detail.streamUrl !== undefined ? { streamUrl: detail.streamUrl } : {}),
          ...(detail.uploadDate !== undefined ? { uploadDate: detail.uploadDate } : {}),
          ...(detail.views !== undefined ? { views: detail.views } : {}),
          ...(detail.sizeBytes !== undefined ? { sizeBytes: detail.sizeBytes } : {}),
        };
      },
    },
    takeRequests: () => {
      const spent = { ...requests };
      requests.search = 0;
      requests.details = 0;
      return spent;
    },
  };
}
