/**
 * SQLite store over `node:sqlite` (built into Node 24). WAL mode, ordered
 * migrations applied in a transaction, and typed repository functions.
 *
 * WAL plus a busy timeout are not optional: the server writes on a 30-minute
 * timer while a one-off cycle (a forced `POST /api/refresh`, `npm run calibrate`)
 * runs concurrently against the same file, and both are meant to touch it.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  DeadVideoLink,
  Fc2Status,
  Scene,
  SourceStatus,
  VideoLink,
  parseAtBoundary,
  type RunKind,
  type RunOutcome,
} from "../schema.ts";
import { toIsoUtc } from "../matching.ts";
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

/** One row of the trusted-pool index. */
export interface PoolVideo {
  id: string;
  uploader: string;
  /** NULL when the profile listing HTML did not expose a title. */
  title: string | null;
  /** ISO timestamp, or NULL when the listing HTML did not expose a date. */
  added: string | null;
  durationSec: number | null;
  hydratedAt: string | null;
  hydrationAttemptedAt?: string | null;
  /**
   * View count, or NULL when no source has ever reported one.
   *
   * NULL is the honest value for "the source did not say", and it is distinct
   * from 0. The ranking chain lets a candidate with a KNOWN count outrank one
   * with none, and falls through to lag when both are NULL, so a fabricated
   * default here would silently reorder the tiebreak it exists to serve.
   */
  views: number | null;
}

/**
 * One FC2 listing candidate and the state of its last detail check.
 *
 * `status` is `'accepted' | 'excluded' | 'pending'`. Pending is the honest
 * third state: fc2cmadb leaves the censorship badge unmarked on most records,
 * and an unmarked badge is neither a yes nor a no.
 */
export interface Fc2Candidate {
  videoId: string;
  releaseDate: string;
  status: Fc2Status;
  verdict: string;
  /** The accepted scene, cached so it can be re-emitted without a detail read. */
  scene: Record<string, unknown> | null;
  firstSeenAt: string;
  checkedAt: string | null;
  /** When an undecided record is due for another detail read; null once decided. */
  recheckAt: string | null;
  /** Set when pending work is abandoned; the row is kept for the audit trail. */
  retiredAt: string | null;
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
    // like a permissions problem, and Render's `/data` only happens to work
    // because the mount point already exists. `:memory:` has no directory, so it
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
        `INSERT INTO scene_links (scene_id, kind, source, url, verified_at, verify_failures, dead_at, dead_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
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
        );
      }
      for (const link of parsed.deadVideoUrls) {
        insert.run(parsed.id, "dead", link.source, link.url, null, 0, link.deadAt, link.deadReason);
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

  // ------------------------------------------------------------ pool_videos

  /**
   * Insert or update one indexed pool video, preserving an existing hydration.
   *
   * `added` is normalised to ISO 8601 UTC on the way in. The index window query
   * is a TEXT range scan, so the column must hold one comparable shape; the raw
   * value from `video/id` is `YYYY-MM-DD HH:MM:SS`, which does not sort against
   * an ISO bound.
   *
   * `views` is COALESCEd on update, exactly like `duration_sec` and `hydrated_at`
   * and for the same reason: this path runs on every listing walk, which supplies
   * a title and a duration but NO view count, so a plain assignment would blank a
   * count the hydration pass had already paid a network request to learn. A
   * genuine deletion of the column's value is not a thing any caller needs.
   */
  upsertPoolVideo(video: PoolVideo): void {
    this.db
      .prepare(
        `INSERT INTO pool_videos (id, uploader, title, added, duration_sec, hydrated_at, views)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id, uploader) DO UPDATE SET
           title = COALESCE(excluded.title, pool_videos.title),
           added = COALESCE(excluded.added, pool_videos.added),
           duration_sec = COALESCE(excluded.duration_sec, pool_videos.duration_sec),
           hydrated_at = COALESCE(excluded.hydrated_at, pool_videos.hydrated_at),
           views = COALESCE(excluded.views, pool_videos.views)`,
      )
      .run(
        video.id,
        video.uploader,
        video.title,
        toIsoUtc(video.added),
        video.durationSec,
        video.hydratedAt,
        video.views,
      );
  }

  /**
   * Indexed rows for an uploader whose upload date is known and inside the
   * window, newest first.
   *
   * `band` narrows the result by the DURATION gate's own arithmetic, in SQL,
   * with the same tolerance the rung runs and the same "a row with no duration
   * is still examined" rule. It is the same narrowing already pushed into SQL
   * for the undated working set, and it changes what the scan has to look at,
   * not what the gate accepts.
   */
  poolVideosInWindow(
    uploader: string,
    from: string,
    to: string,
    band?: { durationSec: number; toleranceSec: number },
  ): PoolVideo[] {
    const sql =
      "SELECT * FROM pool_videos WHERE uploader = ? AND added IS NOT NULL AND added >= ? AND added <= ?" +
      (band ? " AND (duration_sec IS NULL OR ABS(duration_sec - ?) <= ?)" : "") +
      " ORDER BY added DESC, hydration_attempted_at ASC, rowid ASC";
    const rows = band
      ? this.db.prepare(sql).all(uploader, from, to, band.durationSec, band.toleranceSec)
      : this.db.prepare(sql).all(uploader, from, to);
    return (rows as Record<string, unknown>[]).map(rowToPoolVideo);
  }

  /**
   * Indexed rows for an uploader whose upload date is still unknown - which is
   * every row until it has been hydrated, because the profile listing supplies a
   * title and a duration but no date.
   *
   * These cannot be narrowed by the window query, so the pool rung examines them
   * on the duration band alone and lets hydration supply the date. Dropping them
   * instead would discard the entire working set, since the window can never be
   * evaluated without it. See `tubes/eporner-pool.ts`.
   *
   * ORDERED AND CAPPED, LEAST-RECENTLY-SCANNED FIRST. The walk inserts
   * newest-first, so `rowid` order IS newest-first - but that was an accident of
   * SQLite's scan order with nothing asserting it, and `maxConsidered` in the
   * rung silently assumed it. With no `ORDER BY` the rows arrived in whatever
   * order the query plan produced, so the cap cut an arbitrary subset of the
   * account rather than its oldest videos. `ORDER BY rowid` makes the claim
   * explicit, and the cap bounds the scan in SQL rather than after materialising
   * every undated row.
   *
   * `undated_scanned_at` advances on pre-filter rejection or hydration attempts.
   * Rejected rows must rotate too, without claiming a hydration attempt. Rows
   * deferred by the hydration cap keep their place until actually attempted.
   * SQLite sorts NULL first on ASC, so untouched rows lead; rowid breaks ties
   * newest-first. This order must apply BEFORE the SQL limit to reach its tail.
   */
  poolVideosUndated(uploader: string, limit?: number): PoolVideo[] {
    const sql =
      "SELECT * FROM pool_videos WHERE uploader = ? AND added IS NULL " +
      "ORDER BY undated_scanned_at ASC, rowid ASC" +
      (limit === undefined ? "" : " LIMIT ?");
    const rows = (
      limit === undefined
        ? this.db.prepare(sql).all(uploader)
        : this.db.prepare(sql).all(uploader, Math.max(0, Math.floor(limit)))
    ) as Record<string, unknown>[];
    return rows.map(rowToPoolVideo);
  }

  /** Every indexed video for an uploader, hydrated or not. */
  poolVideosForUploader(uploader: string): PoolVideo[] {
    return this.db
      .prepare("SELECT * FROM pool_videos WHERE uploader = ? ORDER BY added DESC")
      .all(uploader)
      .map(rowToPoolVideo);
  }

  /** True when this video is already indexed. Used for the incremental walk's
   *  "nothing new on this page" stop, which is the only stop that works while
   *  the profile listing carries no upload dates. */
  poolVideoExists(id: string, uploader: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM pool_videos WHERE id = ? AND uploader = ?")
      .get(id, uploader) as { present: number } | undefined;
    return row !== undefined;
  }

  setPoolDuration(id: string, uploader: string, durationSec: number, hydratedAt: string): void {
    this.db
      .prepare(
        "UPDATE pool_videos SET duration_sec = ?, hydrated_at = ? WHERE id = ? AND uploader = ?",
      )
      .run(durationSec, hydratedAt, id, uploader);
  }

  /**
   * Persist everything one `video/id` hydration returned.
   *
   * This is the single write path for a pool upload date, and it exists so
   * hydration happens ONCE PER VIDEO rather than once per scene. The date is
   * the reason the gate cannot be evaluated from the index alone: the profile
   * listing carries a title and a duration but no date, and the date is half
   * the gate. Persisting it at hydration time is what keeps rule 2 affordable -
   * the next scene to consider this video gets the date for free.
   *
   * `added` is normalised to ISO 8601 UTC; null means the source did not supply
   * one, which is a distinct state the gate treats as inadmissible rather than
   * as a pass.
   *
   * `views` is COALESCEd for the same reason `added` is. A hydration is a paid
   * network request, so whatever it learned about the view count is persisted
   * for the next scene to use rather than being overwritten by the next listing
   * walk, which cannot supply one.
   */
  setPoolHydration(
    id: string,
    uploader: string,
    durationSec: number,
    added: string | null,
    hydratedAt: string,
    views: number | null = null,
  ): void {
    this.db
      .prepare(
        `UPDATE pool_videos
            SET duration_sec = ?, added = COALESCE(?, added), views = COALESCE(?, views),
                hydrated_at = ?
          WHERE id = ? AND uploader = ?`,
      )
      .run(durationSec, toIsoUtc(added), views, hydratedAt, id, uploader);
  }

  /** Persist a bounded-search attempt, including a transiently failed request. */
  markPoolHydrationAttempt(id: string, uploader: string, attemptedAt: string): void {
    this.db
      .prepare(
        "UPDATE pool_videos SET hydration_attempted_at = ?, undated_scanned_at = ? WHERE id = ? AND uploader = ?",
      )
      .run(attemptedAt, attemptedAt, id, uploader);
  }

  /** Advance a rejected undated row without recording a hydration attempt. */
  markPoolUndatedScan(id: string, uploader: string, scannedAt: string): void {
    this.db
      .prepare(
        "UPDATE pool_videos SET undated_scanned_at = ? WHERE id = ? AND uploader = ? AND added IS NULL",
      )
      .run(scannedAt, id, uploader);
  }

  /** Latest scan or hydration attempt, including rows that now have a date. */
  latestPoolProgressAt(): string | null {
    const row = this.db
      .prepare("SELECT MAX(undated_scanned_at) AS progress_at FROM pool_videos")
      .get() as { progress_at: string | null };
    return row.progress_at;
  }

  /** The incremental watermark: the newest upload date seen for an uploader. */
  poolWatermark(uploader: string): string | null {
    const row = this.db
      .prepare("SELECT MAX(added) AS watermark FROM pool_videos WHERE uploader = ?")
      .get(uploader) as { watermark: string | null } | undefined;
    return row?.watermark ?? null;
  }

  poolVideoCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM pool_videos").get() as { n: number }).n;
  }

  poolUndatedCount(): number {
    return (
      this.db.prepare("SELECT COUNT(*) AS n FROM pool_videos WHERE added IS NULL").get() as {
        n: number;
      }
    ).n;
  }

  /**
   * When the last FULL re-walk ran. This is schedule state, not a summary of
   * the data, so it lives in `pool_meta` rather than being inferred from
   * `MAX(added)` - which is the incremental watermark and a different thing.
   */
  getPoolMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM pool_meta WHERE key = ?").get(key) as
      { value: string } | undefined;
    return row?.value ?? null;
  }

  setPoolMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO pool_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  /** Drop an uploader's rows older than `before`; the re-walk corrects drift. */
  prunePoolUploader(uploader: string, before: string): number {
    return Number(
      this.db
        .prepare("DELETE FROM pool_videos WHERE uploader = ? AND added IS NOT NULL AND added < ?")
        .run(uploader, before).changes,
    );
  }

  /**
   * Drop the rows a full re-walk did NOT see. The profile listing carries no
   * upload date, so the date-keyed prune above can never fire; the re-walk is
   * the only thing that notices an uploader actually deleted a video, and it
   * notices it by absence.
   */
  prunePoolMissing(uploader: string, seen: Set<string>): number {
    const rows = this.db.prepare("SELECT id FROM pool_videos WHERE uploader = ?").all(uploader) as {
      id: string;
    }[];
    const stale = rows.map((row) => row.id).filter((id) => !seen.has(id));
    if (!stale.length) return 0;
    const remove = this.db.prepare("DELETE FROM pool_videos WHERE id = ? AND uploader = ?");
    this.transaction(() => {
      for (const id of stale) remove.run(id, uploader);
    });
    return stale.length;
  }

  close(): void {
    this.db.close();
  }

  // --------------------------------------------------------- fc2_candidates

  /**
   * Record listing sightings, preserving decisions for unchanged release dates.
   * A corrected date resets classification and scheduling so the detail page is
   * checked again before any cached scene can be emitted.
   */
  noteFc2Sightings(
    records: readonly { videoId: string; releaseDate: string }[],
    seenAt: string,
  ): void {
    if (!records.length) return;
    const insert = this.db.prepare(
      `INSERT INTO fc2_candidates
         (video_id, release_date, status, verdict, scene_json, first_seen_at, checked_at, recheck_at, retired_at)
       VALUES (?, ?, 'pending', '', NULL, ?, NULL, NULL, NULL)
       ON CONFLICT (video_id) DO UPDATE SET
         release_date = excluded.release_date,
         status = CASE
           WHEN fc2_candidates.release_date <> excluded.release_date THEN 'pending'
           ELSE fc2_candidates.status
         END,
         verdict = CASE
           WHEN fc2_candidates.release_date <> excluded.release_date THEN ''
           ELSE fc2_candidates.verdict
         END,
         scene_json = CASE
           WHEN fc2_candidates.release_date <> excluded.release_date THEN NULL
           ELSE fc2_candidates.scene_json
         END,
         checked_at = CASE
           WHEN fc2_candidates.release_date <> excluded.release_date THEN NULL
           ELSE fc2_candidates.checked_at
         END,
         recheck_at = CASE
           WHEN fc2_candidates.release_date <> excluded.release_date THEN NULL
           ELSE fc2_candidates.recheck_at
         END,
         retired_at = CASE
           WHEN fc2_candidates.release_date <> excluded.release_date THEN NULL
           ELSE fc2_candidates.retired_at
         END`,
    );
    this.transaction(() => {
      for (const record of new Map(records.map((r) => [r.videoId, r])).values()) {
        insert.run(record.videoId, record.releaseDate, seenAt);
      }
    });
  }

  /** Record one classifier decision, the next recheck, and the accepted scene. */
  decideFc2Candidate(
    videoId: string,
    status: Fc2Status,
    verdict: string,
    {
      checkedAt,
      recheckAt = null,
      scene = null,
    }: { checkedAt: string; recheckAt?: string | null; scene?: Record<string, unknown> | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO fc2_candidates
           (video_id, release_date, status, verdict, scene_json, first_seen_at, checked_at, recheck_at, retired_at)
         VALUES (?, '', ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT (video_id) DO UPDATE SET
           status = excluded.status, verdict = excluded.verdict,
           scene_json = COALESCE(excluded.scene_json, fc2_candidates.scene_json),
           checked_at = excluded.checked_at, recheck_at = excluded.recheck_at,
           retired_at = NULL`,
      )
      .run(
        videoId,
        status,
        verdict,
        scene ? JSON.stringify(scene) : null,
        checkedAt,
        checkedAt,
        recheckAt,
      );
  }

  /** Return a candidate's saved decision and cached scene, or null if unseen. */
  fc2Candidate(videoId: string): Fc2Candidate | null {
    const row = this.db.prepare("SELECT * FROM fc2_candidates WHERE video_id = ?").get(videoId) as
      Record<string, unknown> | undefined;
    return row ? rowToFc2Candidate(row) : null;
  }

  /** The state of every id asked about; ids with no row are absent. */
  fc2Candidates(videoIds: readonly string[]): Map<string, Fc2Candidate> {
    const out = new Map<string, Fc2Candidate>();
    const unique = [...new Set(videoIds)];
    for (let offset = 0; offset < unique.length; offset += 500) {
      const chunk = unique.slice(offset, offset + 500);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM fc2_candidates WHERE video_id IN (${placeholders})`)
        .all(...chunk) as Record<string, unknown>[];
      for (const row of rows) {
        const candidate = rowToFc2Candidate(row);
        out.set(candidate.videoId, candidate);
      }
    }
    return out;
  }

  /**
   * Undecided candidates whose recheck is due, oldest first.
   *
   * `recheck_at IS NULL` is the never-checked case and is always due, so both
   * spellings are folded into one ordered scan. Ordering by `first_seen_at` is
   * what makes bounded work FAIR rather than merely bounded: a run that stops
   * after N checks must not keep spending them on the same rows forever.
   */
  fc2DueCandidates(now: Date, limit: number): Fc2Candidate[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM fc2_candidates
           WHERE status = 'pending' AND retired_at IS NULL
             AND (recheck_at IS NULL OR recheck_at <= ?)
           ORDER BY first_seen_at ASC, video_id ASC
           LIMIT ?`,
      )
      .all(now.toISOString(), Math.max(0, Math.floor(limit))) as Record<string, unknown>[];
    return rows.map(rowToFc2Candidate);
  }

  /**
   * Retire an unmarked candidate after its final scheduled detail retry.
   *
   * The rows are KEPT, with the timestamp, because "we looked and the site still
   * would not say" is a real fact about this candidate and deleting it would make
   * the next sync pay for the same pages to rediscover it. They are excluded from
   * the due queue and from the pending count, which is what stops an unanswerable
   * record from blocking a verified-empty state forever.
   */
  retireFc2StalePending(videoId: string, now: Date): number {
    return Number(
      this.db
        .prepare(
          `UPDATE fc2_candidates SET retired_at = ?
             WHERE video_id = ? AND status = 'pending' AND retired_at IS NULL
               AND recheck_at IS NOT NULL AND recheck_at <= checked_at
               AND checked_at = ?`,
        )
        .run(now.toISOString(), videoId, now.toISOString()).changes,
    );
  }

  /** Drop candidates that have left the rolling window; nothing can revive them. */
  deleteFc2CandidatesBefore(before: string): number {
    return Number(
      this.db.prepare("DELETE FROM fc2_candidates WHERE release_date < ?").run(before).changes,
    );
  }

  /** Outstanding undecided work, so a source cannot claim verified-empty. */
  countFc2Pending(): number {
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS n FROM fc2_candidates WHERE status = 'pending' AND retired_at IS NULL",
      )
      .get() as { n: number };
    return row.n;
  }

  /** Count all stored candidates by status, including retired pending records. */
  fc2CandidateCounts(): Record<Fc2Status, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM fc2_candidates GROUP BY status")
      .all() as { status: Fc2Status; n: number }[];
    const counts: Record<Fc2Status, number> = { accepted: 0, excluded: 0, pending: 0 };
    for (const row of rows) if (row.status in counts) counts[row.status] = row.n;
    return counts;
  }
}

function rowToPoolVideo(row: Record<string, unknown>): PoolVideo {
  return {
    id: String(row.id),
    uploader: String(row.uploader),
    title: (row.title as string | null) ?? null,
    added: (row.added as string | null) ?? null,
    durationSec: row.duration_sec === null ? null : Number(row.duration_sec),
    hydratedAt: (row.hydrated_at as string | null) ?? null,
    hydrationAttemptedAt: (row.hydration_attempted_at as string | null) ?? null,
    // `undefined` means the column is absent, which is what a database created
    // before migration 0003 reports through some drivers. It is normalised to
    // NULL rather than left undefined so the two "no count" spellings cannot
    // diverge in `rank`.
    views: row.views === null || row.views === undefined ? null : Number(row.views),
  };
}

/** Decode a candidate row and its cached scene JSON, preserving nullable timestamps. */
function rowToFc2Candidate(row: Record<string, unknown>): Fc2Candidate {
  const scene = row.scene_json;
  return {
    videoId: String(row.video_id),
    releaseDate: (row.release_date as string | null) ?? "",
    status: String(row.status) as Fc2Status,
    verdict: (row.verdict as string | null) ?? "",
    scene:
      typeof scene === "string" && scene ? (JSON.parse(scene) as Record<string, unknown>) : null,
    firstSeenAt: String(row.first_seen_at),
    checkedAt: (row.checked_at as string | null) ?? null,
    recheckAt: (row.recheck_at as string | null) ?? null,
    retiredAt: (row.retired_at as string | null) ?? null,
  };
}
