/**
 * Deduplicate concurrent lookups for a short window; evict rejections at once.
 * Shared by the tube search layers and the traxxx client so pacing and TTL
 * behaviour stay identical across them.
 */
export function createExpiringCache({ ttlMs, limit = 512 }: { ttlMs: number; limit?: number }) {
  const entries = new Map<string, { createdAt: number; value: Promise<unknown> }>();
  return function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const entry = entries.get(key);
    if (entry && now - entry.createdAt < ttlMs) return entry.value as Promise<T>;
    entries.delete(key);
    const value = Promise.resolve().then(load);
    entries.set(key, { createdAt: now, value });
    value.catch(() => {
      if (entries.get(key)?.value === value) entries.delete(key);
    });
    if (entries.size > limit) entries.delete(entries.keys().next().value as string);
    return value;
  };
}
