# Task 2 Brief: Configuration and baseline check repair

## Changes
- Threaded configured studio declarations from `app.ts` through the source registry into TPDB site/tag contracts.
- Restored Dredd alias and TPDB site IDs 50864, 39697, and 81939 in the default declaration.
- Made the TPDB source conditional on an API key; fixed unique alias registration and protected ambiguous/conflicting short names.
- Corrected TPDB pagination to read the API's `last_page` field and corrected default declaration loading to resolve relative to `import.meta.url`.
- Made Traxxx-only `link-studios` declarations work without a TPDB key.
- Removed unused Maximo listing/host options and corrected test fixtures to the current TPDB catalogue-scan contract.

## TDD and verification
- Added failing config and CLI regressions before their implementation; the TPDB alias regression also failed before the alias map fix.
- Focused config, TPDB adapter, URL parser, and CLI checks: 37/37 pass.
- `npm run typecheck`: pass.
- `npm run lint`: pass.
- `npm run format:check`: pass.
- `npm test`: 547/550 pass. The three existing `read-model-watchlist` failures are the planned Task 4 defect: storage and the read model disagree about duplicate merging and canonical playback state. They are recorded for Task 4 and are not caused by this task.

## Notes
- The test expecting Bang and Maximo in `RETIRED_SOURCE_IDS` was stale: both are currently registered as active source adapters. It now asserts both remain active and TPDB stays absent without credentials.
