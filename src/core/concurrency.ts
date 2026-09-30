/**
 * One shared bound for outbound fetches. Every TOP-LEVEL fan-out over a
 * variable-length list - the per-source cycle, playback lookup across the
 * stored catalogue - draws from ONE process-wide pool, so parallel adapters
 * cannot multiply the burst.
 *
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
 * THE SHARED POOL IS NOT RE-ENTRANT. `acquire` below is a single counter, so a
 * task that ALREADY HOLDS A SLOT and then asks for a second one can only be
 * freed by a task that is itself blocked the same way: at limit N with N
 * holders, the first inner acquire waits for work that cannot start until the
 * inner acquire returns. That is a deadlock, not slow.
 *
 * THE RULE, THEN: the shared pool is for TOP-LEVEL fan-outs only. Anything that
 * can run INSIDE a top-level fan-out - pool hydration inside a scene resolve,
 * the sxyprn detail pass inside a scene resolve, listing hydration inside a
 * source fetch - uses `mapIsolated` and its own counter. It keeps the same
 * clamp so the burst stays bounded, and gives up only the sharing, which was
 * exactly what deadlocked it.
 * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
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

/**
 * The same fan-out with a PRIVATE counter - the one to use from inside another
 * fan-out. Deliberately does NOT share the `active`/`waiters` state above: that
 * state is what makes `mapWithConcurrency` deadlock when re-entered. This
 * function holds no module state at all, so its workers can be at any depth.
 *
 * The clamp is shared, not the count: an isolated fan-out still cannot burst
 * past `MAX_FETCH_CONCURRENCY`, so nesting two of them at the defaults puts at
 * most `4 x 4 = 16` requests in flight rather than an unbounded product.
 *
 * Order is preserved and a rejected task rejects the whole call, exactly as in
 * `mapWithConcurrency`; the difference is the accounting, not the contract.
 */
export async function mapIsolated<T, R>(
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
        results[index] = await task(list[index] as T, index);
      }
    }),
  );
  return results;
}
