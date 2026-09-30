-- The auth subsystem is deleted, so the sessions table has no writer.
--
-- Additive migrations only: `0001_init.sql` is left exactly as it was, because
-- a database already created in the field has applied it and its recorded
-- checksum/ordering must not change underneath `migrate()`. This file drops the
-- table on a fresh database (it is created by 0001 and dropped here, net zero)
-- and on the existing one.
--
-- The only rows it ever held were `sha256(token)` - never a raw token - and
-- sliding expiry deleted expired rows on read, so nothing here is worth
-- retaining.
DROP INDEX IF EXISTS idx_sessions_expires;
DROP TABLE IF EXISTS sessions;