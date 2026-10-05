# Task 3 Brief: Durable provider observations and merge core

## Scope
Add a typed provider observation contract, a SQLite side table keyed by provider/native record ID, migration backfill from existing scenes, atomic upsert/read methods, and a pure deterministic merger that retains field provenance. Sync will persist successful observations alongside current scene rows. This task does not yet remove the existing identity suppression path; Task 4 will switch all deduplication to the shared merger and stable identity.

## Migration invariants
- Existing scene IDs and all `scene_links` rows stay unchanged.
- Legacy scene rows backfill one observation using stored source/label/provenance.
- Provider failures do not write or delete observations.
- A provider/native record repeated on a later successful poll updates its observation in place.

## Verification
- Focused merge, migration, and sync suites: 47/47 pass.
- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run format:check`: pass.
- Migration ledger assertions now include version 10.
- Full suite had 8 failures on its first pass: the three known Task 4 read-model behavior failures, four expected migration-ledger fixtures still asserting through version 9 (corrected), and one unrelated timing-sensitive ManyVids spacing test. Rerun after updating fixtures and again after Task 4.
