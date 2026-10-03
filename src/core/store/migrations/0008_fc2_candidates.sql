-- The FC2 lane's candidate state.
--
-- WHY A SIDE TABLE. The fc2cmadb listing carries a release date, a duration and
-- the CENSORSHIP BADGE, but not the site's full tag list; the tags (and the
-- safety / trans exclusions that read them) live only on the detail page, and a
-- detail page must be requested at 8-9 second spacing. So the listing walk
-- discovers candidates cheaply and the detail walk decides them slowly, and
-- without somewhere to remember "already decided" a normal sync would repay
-- every slow request on every poll - hundreds of them, at 8.5 seconds each.
--
-- STATUS IS THREE VALUES, not two, and the third one is the whole point:
--   'accepted' - an explicit uncensored badge (`無`) and no exclusion matched.
--   'excluded' - a decided non-scene: censored (`有`), removed upstream, no
--                release date, or a safety / trans exclusion.
--   'pending'  - the site did not say. This is NOT "censored" and NOT
--                "accepted": the badge was unmarked, so the record keeps a
--                `recheck_at` and is retried until that passes, after which
--                `retired_at` stops it costing requests forever. It is never
--                promoted to accepted and never demoted to excluded, because
--                either would assert a fact the site never stated.
--
-- `scene_json` CACHES THE SCENE AN ACCEPTED CANDIDATE PRODUCED. It is what lets
-- the lane re-emit an accepted record on every sync without reading its detail
-- page again - an accepted record is part of the catalogue for as long as it is
-- in the window, and a source that stopped emitting it would silently stop
-- refreshing it. `noteFc2Sightings` invalidates the cache when the site corrects
-- a record's release date, so a changed record is re-checked rather than
-- re-emitted from a stale classification.
--
-- `release_date` IS STORED RATHER THAN RE-DERIVED so candidates that have left
-- the rolling window can be deleted in one statement. A pending row for a
-- record three months past its window would otherwise keep the lane from ever
-- reporting a verified-empty state again.
--
-- NO PERSISTENT DISK IS ASSUMED. On a Render instance replacement this table is
-- gone along with everything else and the adapter rebuilds by walking the
-- listing again; an absent row only means a detail request is paid twice.
CREATE TABLE IF NOT EXISTS fc2_candidates (
  video_id      TEXT PRIMARY KEY,
  release_date  TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',
  verdict       TEXT NOT NULL DEFAULT '',  -- the classifier's own reason
  scene_json    TEXT,                      -- the accepted scene, cached
  first_seen_at TEXT NOT NULL,
  checked_at    TEXT,
  recheck_at    TEXT,
  retired_at    TEXT                       -- set when pending work is abandoned
);

-- The pending queue is read as "due, undecided and not retired", oldest first.
CREATE INDEX IF NOT EXISTS idx_fc2_candidates_due
  ON fc2_candidates (status, retired_at, recheck_at);
CREATE INDEX IF NOT EXISTS idx_fc2_candidates_release ON fc2_candidates (release_date);