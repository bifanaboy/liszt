CREATE TABLE scenes (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  source TEXT NOT NULL,
  label_id TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  performers JSONB NOT NULL DEFAULT '[]'::jsonb,
  release_date TEXT NOT NULL,
  duration_sec INTEGER,
  thumbnail_url TEXT NOT NULL DEFAULT '',
  release_url TEXT,
  studio_code TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  provenance JSONB NOT NULL,
  field_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata_poor BOOLEAN NOT NULL DEFAULT FALSE,
  video_checked_at TEXT,
  video_matching JSONB,
  storefront JSONB,
  studio_metadata_checked_at TEXT
);
CREATE INDEX idx_scenes_source ON scenes (source_id);
CREATE INDEX idx_scenes_label ON scenes (label_id);
CREATE INDEX idx_scenes_release ON scenes (release_date);

CREATE TABLE scene_links (
  scene_id TEXT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  verified_at TEXT,
  verify_failures INTEGER NOT NULL DEFAULT 0,
  dead_at TEXT,
  dead_reason TEXT,
  part INTEGER CHECK (part IS NULL OR part > 0),
  PRIMARY KEY (scene_id, kind, source, url)
);
CREATE INDEX idx_scene_links_kind ON scene_links (kind);

CREATE TABLE sources (
  source_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  label TEXT NOT NULL DEFAULT '',
  authority JSONB,
  creator_studio BOOLEAN NOT NULL DEFAULT FALSE,
  window_days INTEGER NOT NULL DEFAULT 90,
  matcher TEXT,
  last_success_at TEXT,
  last_error TEXT,
  scene_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, label_id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'sync',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcomes JSONB NOT NULL DEFAULT '[]'::jsonb,
  ok BOOLEAN,
  error TEXT,
  resolver_health JSONB
);
CREATE INDEX idx_runs_started ON runs (started_at DESC);

CREATE TABLE pool_videos (
  id TEXT NOT NULL,
  uploader TEXT NOT NULL,
  title TEXT,
  added TEXT,
  duration_sec INTEGER,
  hydrated_at TEXT,
  views INTEGER,
  hydration_attempted_at TEXT,
  undated_scanned_at TEXT,
  indexed_order BIGINT GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (id, uploader)
);
CREATE INDEX idx_pool_videos_uploader_added ON pool_videos (uploader, added);

CREATE TABLE pool_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE source_snapshots (source_id TEXT PRIMARY KEY, snapshot TEXT NOT NULL);

CREATE TABLE fc2_candidates (
  video_id TEXT PRIMARY KEY,
  release_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  verdict TEXT NOT NULL DEFAULT '',
  scene_json JSONB,
  first_seen_at TEXT NOT NULL,
  checked_at TEXT,
  recheck_at TEXT,
  retired_at TEXT
);
CREATE INDEX idx_fc2_candidates_due ON fc2_candidates (status, retired_at, recheck_at);
CREATE INDEX idx_fc2_candidates_release ON fc2_candidates (release_date);

CREATE TABLE provider_observations (
  provider_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  studio_id TEXT NOT NULL,
  scene_id TEXT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  studio TEXT NOT NULL,
  record_json JSONB NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, studio_id, record_id)
);
CREATE INDEX idx_provider_observations_scene ON provider_observations (scene_id, provider_id);
