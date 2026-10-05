# Composite Release Repair Execution Ledger

Plan: `docs/superpowers/plans/2026-10-05-composite-release-repair.md`
Mode: Native sequential execution in `/workspace/liszt-repair`.

## Workspace
- Base: `7684dd0` on `origin/main`
- Approved design/spec commits: `f2e05f9`, `bc51440`
- Approved implementation plan: `7e82faa`
- Dependency state: `npm ci` was run in the original worktree; verify lockfile and install dependencies in this worktree before tests.

## Task rulings and evidence

### Task 1: Close source and merge-rule gaps
- Bang source verified live on 2026-10-05: newest listing uses SearchResultsPage JSON-LD and pagination; detail pages use VideoObject JSON-LD. Captured representative URL and fields in `task-1.md` and design spec. Restrict to `www.bang.com` and require production company Bang! Originals.
- Maximo earliest ordering ruling: the user confirmed oldest release date, ties by configured source priority then stable provider ID.
- No production DB available to measure spread; selected a conservative maximum automatic range width of 1 sec; wider ranges need review.
- Per-field conflicts use configured priority and preserve every provider observation/provenance.

## Task progress
- Task 1: completed (spec/source rulings recorded; design remains consistent)
- Task 2: pending
- Task 3: pending
- Task 4: pending
- Task 5: pending
- Task 6: pending
- Task 7: pending
- Task 8: pending

### Task 2: Restore configuration wiring and baseline checks
- Completed. See `task-2.md` for exact changes and verification.
- Ruling: default studio links are resolved relative to `src/config.ts` via `import.meta.url`; the previous `__dirname` path resolved above the repo root under Node native type stripping and silently fell back to no links.
- Ruling: TPDB `meta.last_page` is the pagination field used by the real Laravel-style API contract and repository fixtures; old `meta.last` parsing made all catalogue scans fail at runtime.
- Open: full suite has 3 known read-model failures, which are direct scope for Task 4's one identity/merge path.

## Task progress
- Task 1: completed
- Task 2: completed (typecheck/lint/format pass; focused tests pass; known Task 4 full-suite failures logged)
- Task 3: pending
- Task 4: pending
- Task 5: pending
- Task 6: pending
- Task 7: pending
- Task 8: pending

### Task 3: Persist provider observations and canonical releases
- Observation schema and deterministic per-field merger added.
- Migration 0010 adds provider/native record observations and backfills current scenes from existing provenance.
- Store upsert preserves previously known non-empty fields when a later successful provider response omits them; read and upsert methods added.
- Sync stores observations in the same transaction as provider scene writes; failed sources leave their prior observations untouched.
- Migration regression proves scene IDs, live links, dead-link history, resolver watermark/verdict, and an observation survive upgrade.
- Focused merge/migration/sync tests pass (47/47). Typecheck, lint, format pass.
- Full suite's three remaining read-model failures are assigned to Task 4. One ManyVids spacing test was timing-sensitive on the first full run; Task 8 will rerun it.

### Task 4: Use one conservative identity and merge path
- Canonical reconciliation now runs after successful/failed lanes have been independently recorded; every retained group is rebuilt from observations, including a single remaining provider after another is excluded.
- Removed the pre-write `claimed` suppression and display-time read-model deduplication. Provider observations are retained and same-studio normalized release URLs reconcile into one stored scene.
- Same-host page slug punctuation variants normalize only when a numeric page identifier anchors the URL. Cross-host title similarity and URL-less records remain separate.
- Dead links dominate live links during history merge; a scene with no remaining live links clears its resolver verdict.
- Focused identity, sync, read-model, and resolver checks pass (37/37); typecheck, lint, and formatting pass.
- Maximo's cross-domain lanes share a normalized-title reconciliation key only inside the Maximo identity and only when each observation carries a positive duration. Same-source title collisions remain separate for review.

### Task 5: Add studio policies and repair composite feeds
- Added reusable split/umbrella policy application; split preserves adapter-provided identities and umbrella maps every record to the declared alias.
- Maximo Fansly, ManyVids store `1003095958`, and TPDB aliases (`maximogarcia`, `fuckingpornstars`, `manyvidsmaximogarcia`) now use the `maximo-garcia` studio identity. TPDB site observations retain per-site provider provenance.
- Maximo applies the whole-word `trans` title exclusion. When durations match, canonical release date selection uses the oldest provider date, then stable configured priority.
- Replaced Bang placeholder with a narrow SearchResultsPage/VideoObject JSON-LD parser, exact `www.bang.com` host/path checks, production-company validation, pagination date cutoff, and verified-empty behavior. Bang listing URL is wired through config with a verified default.
- Focused Bang, studio-policy, registry, Maximo, and ManyVids checks pass; static checks pass.

### Task 6: Add duration ranges to matching and display
- Canonical releases retain exact provider durations; equal values stay scalar, disagreements become inclusive min/max ranges with each provider named in `fieldProvenance`.
- A range wider than one second sets `durationReview` and skips automatic resolution. Eligible ranges accept candidates within one second of either edge while preserving date and identity checks.
- SQLite stores range/review fields in its existing storefront JSON column; this avoids a schema migration and preserves existing scene IDs and playback history.
- The dashboard shows exact range runtimes and a REVIEW flag, and includes an expandable field-source list.
- Focused matching, merge, resolution, and sync checks pass; full-suite verification remains in Task 8.

### Task 7: Remove targeted naming and documentation bloat
- README reduced from 529 lines to a concise user guide with setup, feed policies, matching behavior, routes, and config pointers.
- AGENTS shared matching/deployment fact blocks now point to the README; agent-only scope/review rules remain there.
- Removed five completed dated plans under `docs/superpowers/plans/` and `.hermes/plans/`; retained the active repair plan, design, and execution ledger.
- One-word naming review completed for the changed pipeline/source locals; provider/source terms remain where they carry domain meaning.
- Documentation-link review completed; local links resolve. README reduced from 529 to 133 lines.

## Task progress
- Task 1: completed
- Task 2: completed
- Task 3: completed
- Task 4: completed
- Task 5: completed
- Task 6: completed
- Task 7: completed
- Task 8: completed (typecheck, lint, format, 569 tests, HTTP smoke check; no conflict markers; diff check clean)
