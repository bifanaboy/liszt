const VIDEO_URL = "https://www.eporner.com/api/v2/video/id/";
export const EPORNER_HOSTS = Object.freeze(["eporner.com", "www.eporner.com"]);
export function epornerWatchUrl(id) {
  return `https://www.eporner.com/video-${id}/`;
}
export function epornerEmbedUrl(id) {
  return `https://www.eporner.com/embed/${id}/`;
}
export function validEpornerUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== "https:" || !EPORNER_HOSTS.includes(url.hostname)) return false;
    if (url.username || url.password || url.search || url.hash) return false;
    return /^\/(?:video-[A-Za-z0-9]+|hd-porn\/[A-Za-z0-9]+)(?:\/[^/]*)?\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}
export function validEpornerEmbedUrl(value) {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      EPORNER_HOSTS.includes(url.hostname) &&
      /^\/embed\/[A-Za-z0-9]+\/?$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function epornerVideoId(value) {
  try {
    const pathname = new URL(String(value)).pathname;
    return (
      pathname.match(/^\/video-([A-Za-z0-9]+)/)?.[1] ??
      pathname.match(/^\/hd-porn\/([A-Za-z0-9]+)/)?.[1] ??
      null
    );
  } catch {
    return null;
  }
}
export function createExpiringCache({ ttlMs = 5 * 60_000, limit = 512 } = {}) {
  const entries = new Map();
  return function cached(key, load) {
    const now = Date.now();
    const entry = entries.get(key);
    if (entry && now - entry.createdAt < ttlMs) return entry.value;
    entries.delete(key);
    const value = Promise.resolve().then(load);
    entries.set(key, { createdAt: now, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    if (entries.size > limit) entries.delete(entries.keys().next().value);
    return value;
  };
}
export function createEpornerVideoLookup(fetcher) {
  return async (id) => {
    const url = new URL(VIDEO_URL);
    url.searchParams.set("id", id);
    url.searchParams.set("format", "json");
    const data = await fetcher.json(url.href, { headers: { accept: "application/json" } });
    if (Array.isArray(data)) return data.length ? data[0] : null;
    if (data && typeof data === "object" && data.id) return data;
    return null;
  };
}
