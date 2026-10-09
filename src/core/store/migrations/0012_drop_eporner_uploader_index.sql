-- Eporner matching now searches alongside Sxyprn with no uploader allowlist.
-- The old per-uploader listing cache is no longer read or refreshed.
DROP TABLE IF EXISTS pool_videos;
DROP TABLE IF EXISTS pool_meta;
