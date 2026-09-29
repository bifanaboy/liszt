-- 0001_init.sql
-- Liszt's first schema. Applied on startup inside a transaction; every
-- migration file is immutable once committed.
--
-- Scenes are row-per-scene; variable collections (performers, tags,
-- provenance, field provenance, matching evidence) ride as JSON in their own
-- columns rather than as side tables - a personal, read-mostly, single-writer
-- workload where the list is always read with its scene.
--
-- "Source" is the canonical term, not "studio": one source may emit several
-- sub-labels (madouqu emits nine), and health is tracked per sub-label in
-- `sources` keyed by (source_id, label_id).

CREATE TABLE IF NOT EXISTS scenes (
  id                TEXT PRIMARY KEY,        -- <source-id>:<source-scene-id>
  source_id         TEXT NOT NULL,
  source            TEXT NOT NULL,
  label_id          TEXT NOT NULL,
  label             TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL,
  performers        TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  release_date      TEXT NOT NULL,               -- YYYY-MM-DD, date only
  duration_sec      INTEGER,
  thumbnail_url     TEXT NOT NULL DEFAULT '',
  release_url       TEXT,
  studio_code       TEXT,
  tags              TEXT NOT NULL DEFAULT '[]',
  provenance        TEXT NOT NULL,               -- JSON array; never empty
  field_provenance  TEXT NOT NULL DEFAULT '{}',
  metadata_poor     INTEGER NOT NULL DEFAULT 0,
  video_checked_at  TEXT,
  video_matching    TEXT
);

CREATE INDEX IF NOT EXISTS idx_scenes_source ON scenes (source_id);
CREATE INDEX IF NOT EXISTS idx_scenes_label ON scenes (label_id);
CREATE INDEX IF NOT EXISTS idx_scenes_release ON scenes (release_date);

-- Links live in a side table, keyed (scene, kind, source, url), so a metadata
-- upsert never disturbs them and a link can be struck without touching the
-- scene row.
CREATE TABLE IF NOT EXISTS scene_links (
  scene_id    TEXT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                 -- 'live' | 'dead'
  source      TEXT NOT NULL,                 -- 'eporner' | 'eporner-pool' | 'sxyprn'
  url         TEXT NOT NULL,
  verified_at TEXT,                          -- live links
  verify_failures INTEGER NOT NULL DEFAULT 0,
  dead_at     TEXT,                          -- dead links
  dead_reason TEXT,
  PRIMARY KEY (scene_id, kind, source, url)
);

CREATE INDEX IF NOT EXISTS idx_scene_links_kind ON scene_links (kind);

CREATE TABLE IF NOT EXISTS sources (
  source_id        TEXT NOT NULL,
  label_id         TEXT NOT NULL,
  name             TEXT NOT NULL DEFAULT '',
  label            TEXT NOT NULL DEFAULT '',
  authority        TEXT,                      -- JSON object or NULL
  creator_studio   INTEGER NOT NULL DEFAULT 0,
  window_days      INTEGER NOT NULL DEFAULT 90,
  matcher          TEXT,
  last_success_at  TEXT,
  last_error       TEXT,
  scene_count      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, label_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'sync',
  started_at TEXT NOT NULL,
  ended_at   TEXT,
  outcomes   TEXT NOT NULL DEFAULT '[]',     -- JSON array of RunOutcome
  ok         INTEGER,
  error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs (started_at DESC);

-- Only sha256(token) is stored, so a leaked database cannot mint a session.
-- Rows are purged on boot and hourly, and sliding expiry happens on read.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,               -- hex sha256 of the raw token
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

-- The eporner trusted-pool index (rung 1). Indexed incrementally from profile
-- listing HTML and hydrated on demand; duration_sec is persisted permanently so
-- a video is hydrated once, not once per scene per poll.
CREATE TABLE IF NOT EXISTS pool_videos (
  id           TEXT NOT NULL,
  uploader     TEXT NOT NULL,
  title        TEXT,
  added        TEXT,                         -- ISO timestamp, NULL when the
                                              -- listing HTML omitted it
  duration_sec INTEGER,
  hydrated_at  TEXT,
  PRIMARY KEY (id, uploader)
);

-- The per-uploader incremental watermark is derived from MAX(added) rather than
-- kept in a separate state table, so it can never drift from the data it
-- summarises. The FULL RE-WALK CADENCE is genuinely different state - it is a
-- schedule, not a summary - so it lives in its own tiny key/value table rather
-- than being guessed from the data.
CREATE INDEX IF NOT EXISTS idx_pool_videos_uploader_added ON pool_videos (uploader, added);

CREATE TABLE IF NOT EXISTS pool_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
