# Fix: Add Dredd studio declaration as repo default so it works on VPS without env var

The VPS has `TPDB_API_KEY` set but `LISZT_STUDIO_LINKS` is not set, so it defaults to `[]`. Dredd's studio declaration exists only in a local `.studio-links.json` (gitignored), so it doesn't appear on the VPS.

## Solution

Add a fallback in `loadConfig()` to read a committed `studio-links.default.json` from the repo root when `LISZT_STUDIO_LINKS` env var is not set. Commit Dredd's declaration to that file.

## Changes

1. `src/config.ts` - Added fallback reader in `loadConfig()` to read `studio-links.default.json` when `LISZT_STUDIO_LINKS` is not set
2. `studio-links.default.json` - Created in repo root with Dredd's declaration (3 siteIds: 50864, 39697, 81939)

## Verification

- `npm run typecheck` passes
- `npm run format:check` passes
- Default file provides Dredd studio links when `LISZT_STUDIO_LINKS` env var is unset
- Env var `LISZT_STUDIO_LINKS` still takes priority when set