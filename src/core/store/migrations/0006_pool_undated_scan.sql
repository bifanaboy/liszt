-- Pre-filter rejections advance the bounded scan without claiming hydration.
ALTER TABLE pool_videos ADD COLUMN undated_scanned_at TEXT;

-- Preserve the rotation of rows attempted before scan progress was separate.
UPDATE pool_videos SET undated_scanned_at = hydration_attempted_at;
