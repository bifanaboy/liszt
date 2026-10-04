/** Re-analyse the live sync database for duplicates. Read-only. */
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { loadConfig } from "../src/config.ts";
import { SqliteStore } from "../src/core/store/sqlite.ts";
import { systemClock } from "../src/sources/types.ts";
import { cleanStudioName } from "../src/sources/studio-identity.ts";

const config = loadConfig();
// The sync harness wrote its database under a temp dir; find it.
const candidates = readdirSync(tmpdir()).filter((name) => name.startsWith("liszt-dupe-"));
const dbPath = join(tmpdir(), candidates.at(-1)!, "liszt.db");
const store = new SqliteStore(dbPath);
const now = systemClock.now();
const to = now.toISOString().slice(0, 10);
const from = new Date(now.getTime() - config.windowDays * 86_400_000).toISOString().slice(0, 10);
const scenes = store.listWindow(from, to);
process.stdout.write(`db ${dbPath}\nwindow scenes: ${scenes.length}\n`);

const groups = new Map<string, typeof scenes>();
for (const scene of scenes) {
  const key = [
    cleanStudioName(scene.label || scene.source),
    cleanStudioName(scene.title),
    scene.releaseDate,
  ].join("|");
  groups.set(key, [...(groups.get(key) ?? []), scene]);
}
const dupes = [...groups.entries()].filter(([, rows]) => rows.length > 1);
const tpdbInvolved = dupes.filter(([, rows]) =>
  rows.some((r) => r.id.startsWith("tpdb-watchlist:")),
);
process.stdout.write(`duplicate release groups: ${dupes.length}\n`);
process.stdout.write(`  involving the TPDB lane: ${tpdbInvolved.length}\n`);
process.stdout.write(
  `  extra rows they add: ${tpdbInvolved.reduce((n, [, rows]) => n + rows.length - 1, 0)}\n`,
);

const sources = new Map<string, number>();
for (const scene of scenes) sources.set(scene.sourceId, (sources.get(scene.sourceId) ?? 0) + 1);
process.stdout.write("\nrows per source:\n");
for (const [id, n] of [...sources].sort((a, b) => b[1] - a[1])) {
  process.stdout.write(`  ${id.padEnd(42)} ${n}\n`);
}
process.stdout.write("\nsample duplicates:\n");
for (const [key, rows] of tpdbInvolved.slice(0, 6)) {
  process.stdout.write(`  ${key}\n`);
  for (const row of rows) process.stdout.write(`    ${row.id}\n`);
}
store.close();
