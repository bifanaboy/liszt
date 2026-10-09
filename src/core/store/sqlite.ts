/**
 * SQLite store over `node:sqlite` (built into Node 24). WAL mode, ordered
 * migrations applied in a transaction, and typed repository functions.
 *
 * WAL plus a busy timeout are not optional: the server writes on a 30-minute
 * timer while a one-off cycle (a forced `POST /api/refresh`) runs against the
 * same file.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  DeadVideoLink,
  Scene,
  SourceStatus,
  VideoLink,
  parseAtBoundary,
  type RunKind,
  type RunOutcome,
} from "../schema.ts";
import type { ProviderObservation, RawScene } from "../../sources/types.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface RunRecord {
  id: string;
  kind: RunKind;
  startedAt: string;
  endedAt: string | null;
  outcomes: RunOutcome[];
  ok: boolean | null;
  error: string | null;
  /** Resolver rung counters, separate from metadata-source poll outcomes. */
  resolverHealth?: Record<string, number> | null;
}

interface SceneRow {
  id: string;
  source_id: string;
  source: string;
  label_id: string;
  label: string;
  title: string;
  performers: string;
  release_date: string;
  duration_sec: number | null;
  thumbnail_url: string;
  release_url: string | null;
  studio_code: string | null;
  tags: string;
  provenance: string;
  field_provenance: string;
  metadata_poor: number;
  studio_metadata_checked_at: string | null;
  video_checked_at: string | null;
  video_matching: string | null;
  storefront: string | null;
}

/** Rebuild and validate a stored scene from its database row and live and dead links. */
function rowToScene(row: SceneRow, live: VideoLink[], dead: DeadVideoLink[]): Scene {
  const candidate: Record<string, unknown> = {
    id: row.id,
    sourceId: row.source_id,
    source: row.source,
    labelId: row.label_id,
    label: row.label,
    ...(row.storefront ? JSON.parse(row.storefront) : {}),
    title: row.title,
    performers: JSON.parse(row.performers) as string[],
    releaseDate: row.release_date,
    durationSec: row.duration_sec,
    thumbnailUrl: row.thumbnail_url,
    tags: JSON.parse(row.tags) as string[],
    provenance: JSON.parse(row.provenance) as unknown[],
    fieldProvenance: JSON.parse(row.field_provenance) as Record<string, string>,
    metadataPoor: row.metadata_poor === 1,
    studioMetadataCheckedAt: row.studio_metadata_checked_at,
    videoUrls: live,
    deadVideoUrls: dead,
    videoCheckedAt: row.video_checked_at,
    videoMatching: row.video_matching ? (JSON.parse(row.video_matching) as unknown) : null,
  };
  if (row.release_url !== null) candidate.releaseUrl = row.release_url;
  if (row.studio_code !== null) candidate.studioCode = row.studio_code;
  return parseAtBoundary(Scene, candidate, `store.scene(${row.id})`);
}

function linkRowToScene(row: SceneRow, linkRows: Record<string, unknown>[]): Scene {
  const live = linkRows
    .filter((link) => link.kind === "live")
    .map((link) =>
      parseAtBoundary(
        VideoLink,
        {
          source: link.source,
          url: link.url,
          verifiedAt: link.verified_at,
          verifyFailures: Number(link.verify_failures ?? 0),
          ...(link.part == null ? {} : { part: Number(link.part) }),
        },
        `store.link(${row.id})`,
      ),
    );
  const dead = linkRows
    .filter((link) => link.kind === "dead")
    .map((link) =>
      parseAtBoundary(
        DeadVideoLink,
        { source: link.source, url: link.url, deadAt: link.dead_at, deadReason: link.dead_reason },
        `store.deadLink(${row.id})`,
      ),
    );
  return rowToScene(row, live, dead);
}

export class SqliteStore {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;

  constructor(path: string) {
    // The parent directory is created here rather than left to the platform's
    // disk mount. Without it a fresh clone pointed at the default
    // `data/liszt.db` fails at boot with an opaque `SQLITE_CANTOPEN` that reads
    // like a permissions problem, and a pre-created mount point can hide it.
    // `:memory:` has no directory, so it
    // is skipped rather than made a special case of the caller's problem.
    if (path !== ":memory:" && !path.startsWith("file:")) {
      mkdirSync(dirname(resolve(path)), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  migrate(): void {
    // Read the ledger and repair the historical collision under the same lock
    // as the updates. Another process must see the committed schema before it
    // decides which ALTER TABLE statements still need to run.
    this.transaction(() => {
      this.db.exec(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
      );
      const applied = new Set(
        (
          this.db.prepare("SELECT version FROM schema_migrations").all() as {
            version: number;
          }[]
        ).map((row) => row.version),
      );
      // Two branches originally used version 4. Keep resolver health at 4 and
      // hydration attempts at 5. A startup with the colliding files could commit
      // only the pool update before failing; move that ledger entry to its new
      // number so the missing resolver update runs without losing pool data.
      if (applied.has(4) && !applied.has(5)) {
        const poolColumns = this.db.prepare("PRAGMA table_info(pool_videos)").all();
        const runColumns = this.db.prepare("PRAGMA table_info(runs)").all();
        if (
          poolColumns.some((column) => column.name === "hydration_attempted_at") &&
          !runColumns.some((column) => column.name === "resolver_health")
        ) {
          this.db.prepare("UPDATE schema_migrations SET version = 5 WHERE version = 4").run();
          applied.delete(4);
          applied.add(5);
        }
      }
      const files = readdirSync(MIGRATIONS_DIR)
        .filter((file) => file.endsWith(".sql"))
        .sort();
      for (const file of files) {
        const version = Number(file.split("_")[0]);
        if (!Number.isFinite(version) || applied.has(version)) continue;
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        this.db.exec(sql);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(version, new Date().toISOString());
        applied.add(version);
      }
    });
  }

  /** Run `body` inside one transaction, rolling back on any throw. */
  transaction<T>(body: () => T): T {
    // Repository methods such as `upsertScene` own their small transaction so
    // they stay atomic when called directly. A caller may also group several
    // repository writes into one larger unit; in that case the outermost
    // transaction owns COMMIT/ROLLBACK and nested calls use savepoints so a
    // caught nested failure cannot leave partial writes in the outer unit.
    if (this.transactionDepth > 0) {
      const savepoint = `transaction_${this.transactionDepth}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      this.transactionDepth += 1;
      try {
        const value = body();
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return value;
      } catch (error) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      } finally {
        this.transactionDepth -= 1;
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const value = body();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  getSourceSnapshot(sourceId: string): string | null {
    const row = this.db
      .prepare("SELECT snapshot FROM source_snapshots WHERE source_id = ?")
      .get(sourceId);
    return row ? String(row.snapshot) : null;
  }

  setSourceSnapshot(sourceId: string, snapshot: string): void {
    this.db
      .prepare(
        `INSERT INTO source_snapshots (source_id, snapshot) VALUES (?, ?)
      ON CONFLICT (source_id) DO UPDATE SET snapshot = excluded.snapshot`,
      )
      .run(sourceId, snapshot);
  }

  /** Save the latest provider-native record without erasing omitted last-good fields. */
  upsertProviderObservation(observation: ProviderObservation): void {
    this.transaction(() => {
      let prior = this.db
        .prepare(
          `SELECT provider_id, studio_id, record_json FROM provider_observations
         WHERE provider_id = ? AND studio_id = ? AND record_id = ?`,
        )
        .get(observation.providerId, observation.studioId, observation.recordId) as
        { provider_id: string; studio_id: string; record_json: string } | undefined;
      if (!prior && observation.providerId.startsWith("tpdb-site-")) {
        const legacy = this.db
          .prepare(
            `SELECT provider_id, studio_id, record_json FROM provider_observations
           WHERE record_id = ? AND (provider_id = ? OR provider_id = 'tpdb-watchlist')`,
          )
          .all(observation.recordId, observation.providerId) as {
          provider_id: string;
          studio_id: string;
          record_json: string;
        }[];
        if (legacy.length === 1) prior = legacy[0];
      }
      const record: RawScene = prior
        ? { ...(JSON.parse(prior.record_json) as RawScene), ...observation.record }
        : { ...observation.record };
      if (prior) {
        const previous = JSON.parse(prior.record_json) as RawScene;
        for (const field of [
          "performers",
          "durationSec",
          "thumbnailUrl",
          "releaseUrl",
          "tags",
          "storeId",
          "launchDate",
          "previewUrl",
          "price",
          "studioCode",
        ] as const) {
          const value = observation.record[field];
          const blank =
            value === undefined ||
            value === null ||
            value === "" ||
            (Array.isArray(value) && value.length === 0);
          if (blank && previous[field] !== undefined && previous[field] !== null) {
            Object.assign(record, { [field]: previous[field] });
          }
        }
        record.fieldProvenance = {
          ...previous.fieldProvenance,
          ...observation.record.fieldProvenance,
        };
      }
      this.db
        .prepare(
          `INSERT INTO provider_observations
          (provider_id, record_id, studio_id, scene_id, studio, record_json, fetched_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider_id, studio_id, record_id) DO UPDATE SET
          scene_id = excluded.scene_id,
          studio = excluded.studio,
          record_json = excluded.record_json,
          fetched_at = excluded.fetched_at`,
        )
        .run(
          observation.providerId,
          observation.recordId,
          observation.studioId,
          observation.sceneId,
          observation.studio,
          JSON.stringify(record),
          observation.fetchedAt,
        );
      if (
        prior &&
        (prior.provider_id !== observation.providerId || prior.studio_id !== observation.studioId)
      ) {
        this.db
          .prepare(
            "DELETE FROM provider_observations WHERE provider_id = ? AND studio_id = ? AND record_id = ?",
          )
          .run(prior.provider_id, prior.studio_id, observation.recordId);
      }
    });
  }

  /** Current observations, optionally restricted to one canonical release. */
  listProviderObservations(sceneId?: string): ProviderObservation[] {
    const rows = sceneId
      ? this.db
          .prepare(
            `SELECT * FROM provider_observations WHERE scene_id = ?
             ORDER BY provider_id, studio_id, record_id`,
          )
          .all(sceneId)
      : this.db
          .prepare(`SELECT * FROM provider_observations ORDER BY provider_id, studio_id, record_id`)
          .all();
    return (rows as Record<string, unknown>[]).map((row) => ({
      providerId: String(row.provider_id),
      recordId: String(row.record_id),
      studioId: String(row.studio_id),
      sceneId: String(row.scene_id),
      studio: String(row.studio),
      record: JSON.parse(String(row.record_json)) as RawScene,
      fetchedAt: String(row.fetched_at),
    }));
  }

  /** Drop only one provider's positively excluded native records. */
  removeProviderRecords(providerId: string, recordIds: readonly string[]): string[] {
    if (!recordIds.length) return [];
    return this.transaction(() => {
      const found = this.db
        .prepare(
          `SELECT scene_id FROM provider_observations
           WHERE provider_id = ? AND record_id IN (${recordIds.map(() => "?").join(",")})`,
        )
        .all(providerId, ...recordIds) as { scene_id: string }[];
      const sceneIds = new Set(found.map((row) => row.scene_id));

      const scenes = this.db
        .prepare("SELECT id FROM scenes WHERE source_id = ?")
        .all(providerId) as { id: string }[];
      for (const scene of scenes) {
        if (recordIds.some((recordId) => scene.id.endsWith(`:${recordId}`))) {
          sceneIds.add(scene.id);
        }
      }

      this.db
        .prepare(
          `DELETE FROM provider_observations
           WHERE provider_id = ? AND record_id IN (${recordIds.map(() => "?").join(",")})`,
        )
        .run(providerId, ...recordIds);
      for (const sceneId of sceneIds) {
        const retained = this.db
          .prepare("SELECT 1 FROM provider_observations WHERE scene_id = ? LIMIT 1")
          .get(sceneId);
        if (!retained) this.deleteScene(sceneId);
      }
      return [...sceneIds];
    });
  }

  /** Move every retained observation onto its merged canonical release. */
  reassignProviderObservations(sceneIds: readonly string[], canonicalId: string): void {
    for (const sceneId of new Set(sceneIds)) {
      if (sceneId !== canonicalId) {
        this.db
          .prepare("UPDATE provider_observations SET scene_id = ? WHERE scene_id = ?")
          .run(canonicalId, sceneId);
      }
    }
  }

  /** Delete a duplicate scene after its observations and links have been carried forward. */
  deleteScene(sceneId: string): void {
    this.db.prepare("DELETE FROM scenes WHERE id = ?").run(sceneId);
  }

  /** Validate and save a scene, atomically replacing its stored fields and links. */
  upsertScene(scene: Scene): void {
    // Validate at the boundary before writing, so a malformed record names the
    // store and never lands a half-valid row.
    const parsed = parseAtBoundary(Scene, scene, `store.scene(${scene.id})`);
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO scenes (id, source_id, source, label_id, label, title, performers,
             release_date, duration_sec, thumbnail_url, release_url, studio_code, tags,
             provenance, field_provenance, metadata_poor, studio_metadata_checked_at,
             video_checked_at, video_matching, storefront)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             source_id = excluded.source_id, source = excluded.source,
             label_id = excluded.label_id, label = excluded.label, title = excluded.title,
             performers = excluded.performers, release_date = excluded.release_date,
             duration_sec = excluded.duration_sec, thumbnail_url = excluded.thumbnail_url,
             release_url = excluded.release_url, studio_code = excluded.studio_code,
             tags = excluded.tags, provenance = excluded.provenance,
             field_provenance = excluded.field_provenance,
             metadata_poor = excluded.metadata_poor,
             studio_metadata_checked_at = excluded.studio_metadata_checked_at,
             video_checked_at = excluded.video_checked_at,
             video_matching = excluded.video_matching, storefront = excluded.storefront`,
        )
        .run(
          parsed.id,
          parsed.sourceId,
          parsed.source,
          parsed.labelId,
          parsed.label,
          parsed.title,
          JSON.stringify(parsed.performers),
          parsed.releaseDate,
          parsed.durationSec,
          parsed.thumbnailUrl,
          parsed.releaseUrl ?? null,
          parsed.studioCode ?? null,
          JSON.stringify(parsed.tags),
          JSON.stringify(parsed.provenance),
          JSON.stringify(parsed.fieldProvenance),
          parsed.metadataPoor ? 1 : 0,
          parsed.studioMetadataCheckedAt,
          parsed.videoCheckedAt,
          parsed.videoMatching ? JSON.stringify(parsed.videoMatching) : null,
          JSON.stringify({
            storeId: parsed.storeId,
            launchDate: parsed.launchDate,
            previewUrl: parsed.previewUrl,
            price: parsed.price,
            durationRange: parsed.durationRange,
            durationReview: parsed.durationReview,
          }),
        );

      // Links are owned by the resolver, not the metadata fields: they are
      // REPLACED wholesale from the scene this call is handed, never merged.
      // So every caller must hand over a scene read at the moment it decided
      // what the links are. `sync.normaliseScene` carries the stored set
      // forward for exactly that reason - a metadata poll that handed over an
      // empty set would erase every resolved and every dead link, and one that
      // handed over a stale set could resurrect a struck URL.
      this.db.prepare("DELETE FROM scene_links WHERE scene_id = ?").run(parsed.id);
      const insert = this.db.prepare(
        `INSERT INTO scene_links (scene_id, kind, source, url, verified_at, verify_failures, dead_at, dead_reason, part)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const link of parsed.videoUrls) {
        insert.run(
          parsed.id,
          "live",
          link.source,
          link.url,
          link.verifiedAt,
          link.verifyFailures,
          null,
          null,
          link.part ?? null,
        );
      }
      for (const link of parsed.deadVideoUrls) {
        insert.run(
          parsed.id,
          "dead",
          link.source,
          link.url,
          null,
          0,
          link.deadAt,
          link.deadReason,
          null,
        );
      }
    });
  }

  private linksFor(sceneIds: string[]): Map<string, Record<string, unknown>[]> {
    const grouped = new Map<string, Record<string, unknown>[]>();
    if (!sceneIds.length) return grouped;
    const placeholders = sceneIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM scene_links WHERE scene_id IN (${placeholders})`)
      .all(...sceneIds) as Record<string, unknown>[];
    for (const row of rows) {
      const key = String(row.scene_id);
      const list = grouped.get(key) ?? [];
      list.push(row);
      grouped.set(key, list);
    }
    return grouped;
  }

  getScene(id: string): Scene | null {
    const row = this.db.prepare("SELECT * FROM scenes WHERE id = ?").get(id) as
      SceneRow | undefined;
    if (!row) return null;
    return linkRowToScene(row, this.linksFor([id]).get(id) ?? []);
  }

  /**
   * Many scenes at once, links included, keyed by id. Missing ids are absent
   * from the map rather than mapped to null.
   *
   * This exists so the metadata upsert can carry a scene's existing links
   * forward in ONE round trip. `upsertScene` rewrites `scene_links` from the
   * scene it is handed, so a caller that omits them erases them; polling 500
   * scenes must not need 500 separate reads to avoid that.
   */
  getScenesByIds(ids: string[]): Map<string, Scene> {
    const out = new Map<string, Scene>();
    const unique = [...new Set(ids)];
    // Chunked well under SQLite's bound-variable limit, which a wide window
    // with a large per_page can reach.
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM scenes WHERE id IN (${placeholders})`)
        .all(...chunk) as unknown as SceneRow[];
      const links = this.linksFor(rows.map((row) => row.id));
      for (const row of rows) out.set(row.id, linkRowToScene(row, links.get(row.id) ?? []));
    }
    return out;
  }

  /** Scenes in `[from, to]` inclusive, newest first. Links resolved in one query. */
  listWindow(from: string, to: string): Scene[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM scenes WHERE release_date >= ? AND release_date <= ? ORDER BY release_date DESC, id ASC",
      )
      .all(from, to) as unknown as SceneRow[];
    return this.hydrate(rows);
  }

  listAll(): Scene[] {
    const rows = this.db
      .prepare("SELECT * FROM scenes ORDER BY release_date DESC, id ASC")
      .all() as unknown as SceneRow[];
    return this.hydrate(rows);
  }

  private hydrate(rows: SceneRow[]): Scene[] {
    const links = this.linksFor(rows.map((row) => row.id));
    return rows.map((row) => linkRowToScene(row, links.get(row.id) ?? []));
  }

  /** Delete explicitly excluded native IDs within one source, including their links. */
  deleteSourceScenes(sourceId: string, nativeIds: readonly string[]): number {
    const remove = this.db.prepare("DELETE FROM scenes WHERE source_id = ? AND id = ?");
    let count = 0;
    for (const id of new Set(nativeIds))
      count += Number(remove.run(sourceId, `${sourceId}:${id}`).changes);
    return count;
  }

  deleteReleasedBefore(before: string): string[] {
    const rows = this.db.prepare("SELECT id FROM scenes WHERE release_date < ?").all(before) as {
      id: string;
    }[];
    if (!rows.length) return [];
    const remove = this.db.prepare("DELETE FROM scenes WHERE id = ?");
    this.transaction(() => {
      for (const { id } of rows) remove.run(id);
    });
    return rows.map((row) => row.id);
  }

  /** Remove catalogue and health rows for an explicit set of retired lanes. */
  pruneScenesForUnknownSources(sourceIds: readonly string[]): number {
    const retired = [...new Set(sourceIds)];
    if (!retired.length) return 0;
    const placeholders = retired.map(() => "?").join(", ");
    return this.transaction(() => {
      const scenes = Number(
        this.db.prepare(`DELETE FROM scenes WHERE source_id IN (${placeholders})`).run(...retired)
          .changes,
      );
      this.db.prepare(`DELETE FROM sources WHERE source_id IN (${placeholders})`).run(...retired);
      return scenes;
    });
  }

  upsertSource(status: {
    sourceId: string;
    labelId: string;
    name?: string;
    label?: string;
    authority?: unknown;
    creatorStudio?: boolean;
    windowDays?: number;
    matcher?: string | null;
    lastSuccessAt?: string | null;
    lastError?: string | null;
    sceneCount?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sources (source_id, label_id, name, label, authority, creator_studio,
           window_days, matcher, last_success_at, last_error, scene_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id, label_id) DO UPDATE SET
           name = excluded.name, label = excluded.label, authority = excluded.authority,
           creator_studio = excluded.creator_studio, window_days = excluded.window_days,
           matcher = excluded.matcher, last_success_at = excluded.last_success_at,
           last_error = excluded.last_error, scene_count = excluded.scene_count`,
      )
      .run(
        status.sourceId,
        status.labelId,
        status.name ?? "",
        status.label ?? "",
        status.authority ? JSON.stringify(status.authority) : null,
        status.creatorStudio ? 1 : 0,
        status.windowDays ?? 90,
        status.matcher ?? null,
        status.lastSuccessAt ?? null,
        status.lastError ?? null,
        status.sceneCount ?? 0,
      );
  }

  listSources(): SourceStatus[] {
    const rows = this.db.prepare("SELECT * FROM sources ORDER BY source_id, label_id").all() as {
      source_id: string;
      label_id: string;
      name: string;
      label: string;
      authority: string | null;
      creator_studio: number;
      window_days: number;
      matcher: string | null;
      last_success_at: string | null;
      last_error: string | null;
      scene_count: number;
    }[];
    return rows.map((row) =>
      parseAtBoundary(
        SourceStatus,
        {
          sourceId: row.source_id,
          labelId: row.label_id,
          name: row.name,
          label: row.label,
          authority: row.authority ? (JSON.parse(row.authority) as unknown) : null,
          creatorStudio: row.creator_studio === 1,
          windowDays: row.window_days,
          matcher: row.matcher,
          lastSuccessAt: row.last_success_at,
          lastError: row.last_error,
          sceneCount: row.scene_count,
        },
        `store.source(${row.source_id}/${row.label_id})`,
      ),
    );
  }

  recordRun(run: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, kind, started_at, ended_at, outcomes, ok, error, resolver_health) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, ended_at = excluded.ended_at,
           outcomes = excluded.outcomes, ok = excluded.ok, error = excluded.error,
           resolver_health = excluded.resolver_health`,
      )
      .run(
        run.id,
        run.kind,
        run.startedAt,
        run.endedAt,
        JSON.stringify(run.outcomes),
        run.ok === null ? null : run.ok ? 1 : 0,
        run.error,
        run.resolverHealth ? JSON.stringify(run.resolverHealth) : null,
      );
  }

  recentRuns(limit: number): RunRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY started_at DESC LIMIT ?")
      .all(limit) as {
      id: string;
      kind: string;
      started_at: string;
      ended_at: string | null;
      outcomes: string;
      ok: number | null;
      error: string | null;
      resolver_health: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      kind: "sync" as RunKind,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      outcomes: JSON.parse(row.outcomes) as RunOutcome[],
      ok: row.ok === null ? null : row.ok === 1,
      error: row.error,
      resolverHealth: row.resolver_health
        ? (JSON.parse(row.resolver_health) as Record<string, number>)
        : null,
    }));
  }

  close(): void {
    this.db.close();
  }
}
