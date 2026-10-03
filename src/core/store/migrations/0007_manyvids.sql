-- Storefront fields are metadata, distinct from verified playback links.
ALTER TABLE scenes ADD COLUMN storefront TEXT;

-- Full snapshots keep known ids (including expired releases) across restarts.
-- Written only after a successful pull; failures keep the last-good snapshot.
CREATE TABLE source_snapshots (
  source_id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL
);
