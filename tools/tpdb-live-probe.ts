/** Live smoke check: resolve the real watchlist against the real TPDB API. */
import { createSources } from "../src/sources/registry.ts";
import { loadConfig } from "../src/config.ts";
import { HttpFetcher } from "../src/core/fetcher.ts";
import { JsonLogger } from "../src/core/logger.ts";
import { systemClock } from "../src/sources/types.ts";

const config = loadConfig();
const tpdb = createSources({ ...config }).find((s) => s.id === "tpdb-watchlist")!;
const log = new JsonLogger(process.stderr);
const ctx = {
  now: new Date(),
  fetcher: new HttpFetcher(20_000),
  log: (m: string, d?: unknown) => log.info(m, d ?? {}),
  mapWithConcurrency: async (items: unknown[], fn: (i: unknown) => unknown) =>
    Promise.all(items.map(fn)),
  mapIsolated: async (items: unknown[], fn: (i: unknown) => unknown) => Promise.all(items.map(fn)),
  clock: systemClock,
} as never;

const start = Date.now();
const windowStart = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
const result = await tpdb.fetch(windowStart, ctx);
console.log("elapsed_s:", ((Date.now() - start) / 1000).toFixed(1));
console.log("scenes:", result.scenes.length, "verifiedEmpty:", result.verifiedEmpty);
const byStudio = new Map<string, number>();
for (const s of result.scenes) byStudio.set(s.studio, (byStudio.get(s.studio) ?? 0) + 1);
console.log("studios with scenes:", byStudio.size);
for (const [name, n] of [...byStudio].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${name}`);
console.log("sample:", JSON.stringify(result.scenes[0], null, 1)?.slice(0, 600));
