# FC2 Lane Simplification: Listing-Only Discovery

**Date:** 2026-10-10
**Status:** Draft — awaiting review

## Plain-language summary

The current FC2 lane is complex because it fetches every candidate's detail page (8–9 s each) to resolve censorship status, duration, and tags. A 90-day window holds hundreds of candidates, so the lane uses a persistent queue (`fc2_candidates` table), a bounded per-sync budget, and a retry scheduler — about 700 lines of code.

This spec replaces that with a **listing-only lane**: walk the anal-tag listing, filter on fields the listing already provides, emit scenes immediately, match by FC2 code alone. No detail fetches, no queue, no store. The lane shrinks to ~150 lines.

**Trade-offs accepted:**
- **Censorship filter:** Only drops `censored: "有"` (explicitly censored). Records with `censored: null` (unknown) are emitted — some censored ones will leak in.
- **Trans/safety exclusion:** Runs against the **listing title only** (no tags on listing). Title-based exclusion catches most cases.
- **Duration:** Uses listing `duration` string; converted to seconds for the catalogue.
- **Release date:** Uses listing `release_date` (diverges from detail date in ~65% of records by ±1 day).
- **Matching:** Code-only via sxyprn + eporner. No title fuzzy matching, no duration verification.
- **No tags:** Tags are only on detail page; the emitted scenes have empty tag arrays.

If the catalogue quality is acceptable, the machinery disappears.

## Technical summary

### Current architecture (removed)
- `createFc2Client` with dual pacing gates (listing + detail)
- `walkFc2Listing` → `parseFc2Detail` → `classifyFc2Candidate` → `toFc2RawScene`
- `fc2_candidates` table (store): `noteFc2Sightings`, `fc2DueCandidates`, `decideFc2Candidate`, `retireFc2StalePending`, `countFc2Pending`
- Per-sync detail budget (`maxDetailChecksPerSync`), recheck window (`recheckDays`)
- `verifiedEmpty` gated on `deferred === 0 && !walk.edgeStop`

### New architecture
- `createFc2Client` with **listing pacing only** (2 s default)
- `walkFc2Listing` (unchanged logic, same window-edge stop)
- Single-pass filter in `fetch()`:
  1. Drop `censored === "有"`
  2. Drop `notFound === true`
  3. Drop `findTransExclusion(title)`
  4. Emit `RawScene` with `releaseDate`, `duration` (parsed to seconds), `thumbnailUrl`, empty tags
- `verifiedEmpty = scenes.length === 0 && walk.reachedEnd && !walk.edgeStop` (no `deferred` concept)
- No store dependency, no `Fc2StudioOptions.store`, no config keys for detail pacing/budget/recheck

### Config changes (removed)
- `fc2DetailMinIntervalMs`
- `fc2MaxDetailChecksPerSync`
- `fc2RecheckDays`
- Kept: `fc2ListingMinIntervalMs` (default 2000)

### Matcher
- Unchanged: `"sxyprn+eporner"` (both search by FC2 code)

## Detailed spec

### `src/sources/fc2cmadb.ts` — new exports
- `extractInertiaPage` (unchanged)
- `parseFc2Listing` (unchanged)
- `walkFc2Listing` (unchanged)
- `createFc2Client` → listing-only, single pacing gate
- `createFc2CmadbStudio` → `Fc2StudioOptions = { listingMinIntervalMs?, sleep?, maxListingPages? }`
- `fc2RecordUrl`, `FC2_LISTING_URL`, constants, error classes (unchanged)

**Removed exports:**
- `parseFc2Detail`, `Fc2Detail`, `classifyFc2Candidate`, `Fc2Verdict`, `Fc2ClassifyInput`
- `toFc2RawScene`
- `Fc2ClientOptions.detailMinIntervalMs`
- `Fc2StudioOptions.store`, `maxDetailChecksPerSync`, `recheckDays`
- `FC2_SAFETY_TERMS`, `FC2_SAFETY_WORD_TERMS`, `firstMatch`, `firstWordMatch` (moved to trans-exclusion if needed elsewhere)
- `Fc2RemovedRecordError` (no detail fetches → no 404/410 on detail)

### `src/sources/registry.ts`
- `createFc2CmadbStudio({ ...fc2 })` — no `store` spread

### `src/app.ts`
- `fc2` config object passes only `listingMinIntervalMs`

### `src/config.ts`
- Remove `fc2DetailMinIntervalMs`, `fc2MaxDetailChecksPerSync`, `fc2RecheckDays` from schema and env mapping

### Database
- `fc2_candidates` table becomes unused. **Not dropped** (migration is separate concern; table can remain for rollback/inspection).

### Tests
- Delete `test/fc2cmadb.test.ts` (tests detail walk, classifier, candidate queue)
- Delete `test/fc2-link-persistence.test.ts` (tests detail-link persistence via store)
- Keep `test/fc2cmadb-simple.test.ts` (tests simplified lane with fixtures)

## Failure cases preserved

| Failure | Current behaviour | New behaviour |
|---------|-------------------|---------------|
| Listing 429 / 404 / 5xx | `Fc2RateLimitedError` / `Fc2SourceError` → run fails, last-good retained | Same |
| Inertia payload missing/malformed | `Fc2ShapeError` → run fails | Same |
| Repeated cursor | `Fc2ShapeError` → run fails | Same |
| Page ceiling hit before window edge | `Fc2SourceError` → run fails | Same |
| Walk stops at window edge with cursor | `edgeStop = true` → `verifiedEmpty = false` | Same |
| Walk reaches end (no cursor) | `edgeStop = false` → `verifiedEmpty` allowed if no scenes | Same |

## Open decisions (resolved in this spec)

1. **Drop `censored: null` or emit?** → Emit (simpler, leakage bounded).
2. **Trans exclusion on title only?** → Yes (tags unavailable on listing).
3. **Keep `fc2_candidates` table?** → Leave it (no migration in this change).
4. **Matcher change?** → No, keep `sxyprn+eporner`.
5. **Config backwards compat?** → Not needed (breaking change, no deployed instances depend on removed keys).

## Self-review

- [x] Placeholder scan: no TBD/TODO
- [x] Internal consistency: config, registry, adapter all aligned
- [x] Scope: single lane replacement, no other lanes touched
- [x] Ambiguity check: "stupider" catalogue quality is explicit; leakage quantified where possible (65% date drift, 93% censored null)

## How we'll know it works

1. `npm run typecheck` passes
2. `npm run lint` passes
3. `test/fc2cmadb-simple.test.ts` passes (fixture-driven, no network)
4. A manual sync run with the simplified lane:
   - Logs `fc2: walk finished` with `scenes: N`, `verifiedEmpty: boolean`
   - No `fc2: detail check failed` logs
   - No `Fc2RateLimitedError` from detail pacing
   - Scenes appear in catalogue with `releaseDate`, `duration`, `thumbnailUrl`
   - Matching finds links via code search