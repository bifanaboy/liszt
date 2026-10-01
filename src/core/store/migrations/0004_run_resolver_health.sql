-- Keep resolver availability alongside, and distinct from, catalogue-source
-- outcomes. Older run rows intentionally remain NULL (unknown).
ALTER TABLE runs ADD COLUMN resolver_health TEXT;
