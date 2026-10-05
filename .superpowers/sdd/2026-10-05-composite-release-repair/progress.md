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
- Maximo earliest ordering ruling: earliest `datePublished`/release date, ties by configured source priority then stable provider ID. This is reversible because the issue comment did not specify an ordering field.
- No production DB available to measure spread; choose a conservative maximum automatic range width of 1 sec; wider ranges need review.
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
