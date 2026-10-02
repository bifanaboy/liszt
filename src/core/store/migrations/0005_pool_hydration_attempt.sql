-- Record attempts separately from successful hydration so transient failures
-- do not pin the same early candidate at the head of every bounded search.
ALTER TABLE pool_videos ADD COLUMN hydration_attempted_at TEXT;
