export const DEFAULT_FETCH_CONCURRENCY = 4;
const MIN_FETCH_CONCURRENCY = 1;
const MAX_FETCH_CONCURRENCY = 16;
export function resolveFetchConcurrency(value = undefined) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < MIN_FETCH_CONCURRENCY) return DEFAULT_FETCH_CONCURRENCY;
  return Math.min(MAX_FETCH_CONCURRENCY, Math.floor(parsed));
}
let active = 0;
const waiters = [];
async function acquire(limit) {
  while (active >= limit) await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}
function release() {
  active -= 1;
  waiters.shift()?.();
}
async function withFetchSlot(task, limit) {
  await acquire(limit);
  try {
    return await task();
  } finally {
    release();
  }
}
export async function mapWithConcurrency(items, task, concurrency = resolveFetchConcurrency()) {
  const list = Array.from(items);
  const limit = Math.max(1, Math.min(resolveFetchConcurrency(concurrency), list.length || 1));
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < list.length) {
        const index = next++;
        results[index] = await withFetchSlot(() => task(list[index], index), limit);
      }
    }),
  );
  return results;
}
export async function mapIsolated(items, task, concurrency = resolveFetchConcurrency()) {
  const list = Array.from(items);
  const limit = Math.max(1, Math.min(resolveFetchConcurrency(concurrency), list.length || 1));
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < list.length) {
        const index = next++;
        results[index] = await task(list[index], index);
      }
    }),
  );
  return results;
}
