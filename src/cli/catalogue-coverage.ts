/** Compare optional provider exports; otherwise report the local ManyVids/Traxxx union. */
import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { SqliteStore } from "../core/store/sqlite.ts";
import {
  CATALOGUE_PROVIDERS,
  catalogueCoverage,
  type CatalogueProvider,
  type CatalogueRecord,
} from "../core/catalogue-coverage.ts";

const { values } = parseArgs({
  options: Object.fromEntries([
    ...CATALOGUE_PROVIDERS.map((provider) => [provider, { type: "string" }]),
    ["help", { type: "boolean" }],
  ]) as Record<string, { type: "string" | "boolean" }>,
});
if (values.help) {
  process.stdout.write(
    "Usage: npm run catalogue-coverage -- [--tpdb file.json] [--stashdb file.json] [--traxxx file.json] [--manyvids file.json]\nExports: array of { id, title, releaseDate (YYYY-MM-DD), durationSec }, or { scenes: [...] }. Without files, reads the local watchlist.\n",
  );
} else {
  const input: Partial<Record<CatalogueProvider, CatalogueRecord[]>> = {};
  if (CATALOGUE_PROVIDERS.some((provider) => values[provider] !== undefined)) {
    for (const provider of CATALOGUE_PROVIDERS) {
      const path = values[provider];
      if (typeof path !== "string") continue;
      const data = JSON.parse(readFileSync(path, "utf8"));
      const records = Array.isArray(data) ? data : data.scenes;
      if (!Array.isArray(records))
        throw new Error(`${provider}: expected a scene array or { scenes: [...] }`);
      input[provider] = records;
    }
  } else {
    const config = loadConfig();
    const store = new SqliteStore(config.dbPath);
    try {
      store.migrate();
      const now = new Date();
      const from = new Date(now.getTime() - config.windowDays * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const scenes = store.listWindow(from, now.toISOString().slice(0, 10));
      const sources = store.listSources();
      for (const provider of ["manyvids", "traxxx"] as const) {
        const sourceIds = new Set(
          sources
            .filter(
              (source) =>
                source.authority?.name.toLowerCase() ===
                (provider === "traxxx" ? "traxxx.me" : provider),
            )
            .map((source) => source.sourceId),
        );
        if (sourceIds.size)
          input[provider] = scenes.filter((scene) => sourceIds.has(scene.sourceId));
      }
    } finally {
      store.close();
    }
  }
  process.stdout.write(`${JSON.stringify(catalogueCoverage(input), null, 2)}\n`);
}
