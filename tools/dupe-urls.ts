/** Do duplicate rows share a release URL? That decides the dedup key. */
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStore } from "../src/core/store/sqlite.ts";

const dbPath = join(
  tmpdir(),
  readdirSync(tmpdir())
    .filter((n) => n.startsWith("liszt-dupe-"))
    .at(-1)!,
  "liszt.db",
);
const store = new SqliteStore(dbPath);
const scenes = store
  .listAll()
  .filter(
    (s) =>
      s.id.startsWith("channel-darkkotv") || s.id.startsWith("tpdb-watchlist:channel-darkkotv"),
  );
for (const scene of scenes.slice(0, 8)) {
  process.stdout.write(
    `${scene.id}\n   title: ${scene.title}\n   date: ${scene.releaseDate}\n   url: ${scene.releaseUrl ?? "(none)"}\n`,
  );
}
store.close();
