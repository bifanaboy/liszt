CREATE TABLE provider_observations (
  provider_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  studio_id TEXT NOT NULL,
  scene_id TEXT NOT NULL REFERENCES scenes (id) ON DELETE CASCADE,
  studio TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK (json_valid(record_json)),
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, studio_id, record_id)
);

CREATE INDEX idx_provider_observations_scene
  ON provider_observations (scene_id, provider_id);

INSERT INTO provider_observations (
  provider_id, record_id, studio_id, scene_id, studio, record_json, fetched_at
)
SELECT
  source_id,
  COALESCE(json_extract(provenance, '$[0].sourceSceneId'), id),
  label_id,
  id,
  label,
  json_object(
    'sourceSceneId', COALESCE(json_extract(provenance, '$[0].sourceSceneId'), id),
    'title', title,
    'releaseDate', release_date,
    'performers', json(performers),
    'durationSec', duration_sec,
    'thumbnailUrl', thumbnail_url,
    'releaseUrl', release_url,
    'studioId', label_id,
    'studio', label,
    'source', source,
    'tags', json(tags),
    'fieldProvenance', json(field_provenance)
  ),
  COALESCE(json_extract(provenance, '$[0].fetchedAt'), CURRENT_TIMESTAMP)
FROM scenes;
