/**
 * One shared bound for outbound fetches. Every fan-out over a variable-length
 * list - direct-scrape page hydration during ingest, playback lookup across the
 * stored catalogue - draws from ONE process-wide pool, so parallel adapters
 * cannot multiply the burst.
 */
export const DEFAULT_FETCH_CONCURRENCY = 4;
const MIN_FETCH_CONCURRENCY = 1;
const MAX_FETCH_CONCURRENCY = 16;

/** Resolve the configured in-flight limit, clamped to a sane range. */
export function resolveFetchConcurrency(value: string | number | undefined = undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_FETCH_CONCURRENCY) return DEFAULT_FETCH_CONCURRENCY;
  return Math.min(MAX_FETCH_CONCURRENCY, Math.floor(parsed));
}

let active = 0;
const waiters: (() => void)[] = [];

async function acquire(limit: number): Promise<void> {
  while (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
}

function release(): void {
  active -= 1;
  waiters.shift()?.();
}

/** Run `task` holding one slot of the shared pool. */
async function withFetchSlot<T>(task: () => Promise<T>, limit: number): Promise<T> {
  await acquire(limit);
  try {
    return await task();
  } finally {
    release();
  }
}

/**
 * Run `task` over `items` through the shared pool, preserving input order.
 * A rejected task rejects the whole call, matching `Promise.all`; callers that
 * need per-item isolation collect their own outcomes.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  task: (item: T, index: number) => Promise<R>,
  concurrency: number = resolveFetchConcurrency(),
): Promise<R[]> {
  const list = Array.from(items);
  const limit = Math.max(1, Math.min(resolveFetchConcurrency(concurrency), list.length || 1));
  const results = new Array<R>(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < list.length) {
        const index = next++;
        results[index] = await withFetchSlot(() => task(list[index] as T, index), limit);
      }
    }),
  );
  return results;
}
