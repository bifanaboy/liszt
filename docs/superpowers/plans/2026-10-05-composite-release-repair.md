# Composite Release Repair Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` for native sequential execution, or `superpowers:subagent-driven-development` for task-by-task implementation and review. Steps use checkbox syntax for tracking.

**Goal:** Ingest disparate provider feeds into one canonical release per verified release identity, preserve field provenance, support separate or umbrella studio assignment, and repair the audited runtime, check, naming, and documentation issues.

**Architecture:** Each provider-specific adapter converts its API response to a shared observation. A shared merge step stores those observations and builds the canonical release used by matching and the dashboard. Studio policy defaults to separate identities and can assign a feed to an umbrella alias.

**Tech Stack:** Node 24, TypeScript native type stripping, Zod, SQLite migrations, Node test runner, ESLint, Prettier.

**Spec:** [2026-10-05-composite-release-repair-design.md](../specs/2026-10-05-composite-release-repair-design.md)

## Global Constraints

- Treat the duration tolerance as ±1 second at the edges of a canonical duration range.
- Keep existing release-date and identity gates; duration alone cannot name a match.
- Keep provider failures isolated and retain last-good observations.
- Do not merge cross-host records by title alone.
- Separate studios by default; apply an umbrella alias only when declared.
- Preserve existing playback links and dead-link history through migrations.
- Use one descriptive word for local variables in changed code; prefer clear domain words over short or generic names.
- Do not change hosting or deployment settings.

## Review Focus

- Same release URL with harmless spelling differences: merge only when normalization proves identity.
- Different hosts with similar titles: retain as separate records without shared identity evidence.
- One provider fails or omits a field: keep other providers' last-good values and provenance.
- Studio identity is missing in separate mode: report for review; do not assign a guessed studio.
- Duration observations disagree: retain exact observations, derive a range, and hold overly wide ranges for review.

---

## File Map

- `src/sources/types.ts` — provider observation, static feed definition, and studio policy contracts.
- `src/sources/registry.ts`, `src/config.ts`, `studio-links.default.json` — feed and studio policy wiring.
- `src/pipeline/release-identity.ts` — conservative shared release identity.
- `src/pipeline/release-merge.ts` — canonical field selection and provenance.
- `src/pipeline/sync.ts` — persist observations and rebuild canonical releases.
- `src/core/schema.ts`, `src/core/store/sqlite.ts`, `src/core/store/migrations/0010_provider_observations.sql` — validated duration range, review flag, and durable observations.
- `src/tubes/types.ts`, `src/core/matching.ts`, `src/tubes/resolve.ts`, `public/app.js` — range-aware linking and display.
- `src/sources/bang-originals.ts`, `src/sources/maximo-garcia.ts`, `src/sources/tpdb-watchlist.ts` — verified composite feeds.
- `src/cli/link-studios.ts` and focused CLI tests — optional TPDB key behavior.
- `test/` — regression and adapter coverage.
- `README.md`, `AGENTS.md`, `docs/superpowers/`, `.hermes/plans/` — targeted documentation cleanup after behavior stabilizes.

## Task 1: Close source and merge-rule gaps

**Files:** Review issue #115, #130, and #144; update the spec only if decisions change.

- [ ] Confirm what “earliest video” means for Maximo duplicates. Use the issue's stated rule only after its ordering field is identified.
- [ ] Set the non-duration conflict rule: use a deterministic per-studio source priority, preserve all observations, and record the selected value's source.
- [ ] Measure observed duration spreads and set the largest spread eligible for automatic matching. Keep the existing ±1-second edge tolerance; wider ranges require review.
- [ ] Obtain and capture a real Bang listing URL and response sample. If unavailable, leave Bang's concrete parser explicitly blocked and do not invent a schema.
- [ ] Record the resolved values and source evidence in the spec, then review any behavior-changing spec update before implementation.

**Deliverable:** Four decisions are either evidence-backed and recorded or explicitly blocked on user-provided source material.

## Task 2: Restore configuration wiring and baseline checks

**Files:** Modify `src/app.ts`, `src/sources/registry.ts`, `src/sources/studio-identity.ts`, `src/sources/tpdb-watchlist.ts`, `studio-links.default.json`, and `src/cli/link-studios.ts`; update `test/config.test.ts`, `test/studio-identity.test.ts`, `test/tpdb-watchlist.test.ts`, `test/tpdb-listing-url.test.ts`; add `test/link-studios-cli.test.ts`.

- [ ] Add `default studio links register every TPDB site ID under one studio` in `test/config.test.ts` and `test/tpdb-watchlist.test.ts`; assert Dredd emits under one studio identity for IDs `50864`, `39697`, and `81939`.
- [ ] Add `Traxxx-only declaration works without TPDB key` in `test/link-studios-cli.test.ts`; assert it writes/prints the declaration without resolving TPDB.
- [ ] Run the focused tests and confirm they fail for the reported wiring/type-shape reasons.
- [ ] Make the registry consume `studioLinks`; represent configured multiple site IDs and tags in the TPDB adapter contract; restore Dredd's alias and IDs `50864`, `39697`, and `81939` in the default declaration.
- [ ] Check for a TPDB key only when a TPDB URL must be resolved; preserve clear failure for TPDB-dependent input without the key.
- [ ] Align test fixtures with the multi-site TPDB contract. Remove the unused Maximo listing URL and allowed-host parameters; studio feed declarations and provider adapters own those inputs.
- [ ] Format `src/sources/registry.ts` and `studio-links.default.json` with Prettier, then run `npm run typecheck`, `npm run lint`, and `npm run format:check`; fix the current failures without suppressing the checks.

**Deliverable:** Configured studio links are effective and the reported type, lint, and formatting failures are cleared.

## Task 3: Persist provider observations and canonical releases

**Files:** Modify `src/sources/types.ts`, `src/core/schema.ts`, and `src/core/store/sqlite.ts`; create `src/core/store/migrations/0010_provider_observations.sql` and `src/pipeline/release-merge.ts`; create `test/release-merge.test.ts` and update `test/migrations.test.ts`.

- [ ] Add `merges provider observations and keeps field provenance`, `uses the configured source priority for conflicting fields`, and `missing fields retain the last good provider value` in `test/release-merge.test.ts`; assert one canonical release, correct selected values, source names, and retained observations.
- [ ] Add `failed provider keeps its last good observation` in `test/sync.test.ts`; assert other providers still update the canonical release.
- [ ] Add `observation migration preserves release IDs and playback history` in `test/migrations.test.ts`; assert existing scene IDs, live links, dead links, and resolver state survive migration.
- [ ] Run the focused tests and verify they fail before implementation.
- [ ] Define `ProviderObservation` in `src/sources/types.ts` with `providerId`, `recordId`, `studioId`, `studio`, `record: RawScene`, and `fetchedAt`; define `StudioPolicy` as `split` or `umbrella`, and `MergePolicy` with per-field provider priority.
- [ ] Persist one latest observation per provider-native record and associate observations with one stable canonical release ID.
- [ ] Implement `mergeRelease(observations: readonly ProviderObservation[], policy: MergePolicy): Scene` in `src/pipeline/release-merge.ts`; select canonical values deterministically, retain all source provenance, and avoid changing playback-owned fields.
- [ ] Migrate current scene data into observations without discarding scene IDs, links, dead-link history, or resolver state.
- [ ] Run migration and merge tests, including rollback/failure behavior supported by existing store patterns.

**Deliverable:** A canonical release is built from durable provider observations without losing last-good fields or link history.

## Task 4: Use one conservative identity and merge path

**Files:** Modify `src/pipeline/release-identity.ts`, `src/pipeline/sync.ts`, `src/serving/read-model.ts`; add or update `test/release-identity.test.ts`, `test/sync-release-dedup.test.ts`, and `test/read-model-watchlist.test.ts`.

- [ ] Add `normalizes verified URL punctuation variants`, `does not merge same-title releases on different hosts`, `merges a verified shared provider identity`, and `repeated sync updates one canonical release` in `test/release-identity.test.ts` and `test/sync-release-dedup.test.ts`.
- [ ] Run the focused tests and verify current separate suppression/display merge behavior fails the new expectations.
- [ ] Normalize only identity-safe URL differences, including host case, fragment, trailing slash, and punctuation variants backed by issue #130 evidence.
- [ ] Merge observations before storage through the shared release merger; remove the separate `claimed` drop path and display-only duplicate merger once their behavior is covered by the shared path.
- [ ] Keep records with no reliable identity and ambiguous mirror pages separate; never merge by title alone across hosts.
- [ ] Ensure sync outcomes still report each provider independently and failed polls preserve observations.

**Deliverable:** Storage and the read model show the same single canonical record for verified duplicates.

## Task 5: Add studio policies and repair composite feeds

**Files:** Modify `src/sources/registry.ts`, `src/config.ts`, `src/sources/fansly.ts`, `src/sources/manyvids.ts`, `src/sources/tpdb-watchlist.ts`, `src/sources/maximo-garcia.ts`, `src/sources/bang-originals.ts`, and `studio-links.default.json`; add provider fixtures and focused adapter tests.

- [ ] Add `split mode keeps different studio identities` and `umbrella mode assigns every record to its alias` in `test/source-adapter-review.test.ts`; assert default split and explicit umbrella behavior.
- [ ] Add `unknown studio identity is reported without misassignment` in `test/source-adapter-review.test.ts`; assert the record is reviewable and no unrelated studio receives it.
- [ ] Define a static `FeedDefinition` with provider adapter ID, source URL, and `StudioPolicy`; register each declared feed with its provider-specific adapter. Adding a URL from a new API requires an adapter for that API; do not add generic unknown-URL fetching.
- [ ] Add `Maximo provider feeds share one studio identity` in `test/maximo-garcia.test.ts`; assert Fansly, ManyVids store `1003095958`, and TPDB sites `fuckingpornstars`, `maximogarcia`, and `manyvidsmaximogarcia` map to one Maximo identity.
- [ ] Test the exact approved Maximo exclusion marker and duplicate ordering rule from Task 1.
- [ ] Implement provider adapters that validate real captured formats, normalize exact fields and provenance, and isolate network/parser failures.
- [ ] Make unconfigured optional feeds report setup-required/disabled status rather than repeated parser failure.
- [ ] Implement Bang parsing only from the verified URL and sample captured in Task 1; test date-window filtering and verified-empty versus parse-failure behavior.
- [ ] Run adapter and registry tests, including TPDB multi-site emission deduplication.

**Deliverable:** Each supported feed has a narrow adapter and all declared studio lanes feed the shared canonical-release path.

## Task 6: Add duration ranges to matching and display

**Files:** Modify `src/core/schema.ts`, `src/pipeline/release-merge.ts`, `src/core/matching.ts`, `src/tubes/types.ts`, `src/tubes/resolve.ts`, `src/serving/read-model.ts`, and `public/app.js`; update `test/matching.test.ts`, `test/resolve.test.ts`, `test/read-model-watchlist.test.ts`, and browser-facing tests.

- [ ] Add `equal source durations stay scalar`, `candidate inside duration range is eligible`, `candidate at either one-second edge is eligible`, `candidate outside duration range is rejected`, and `over-limit duration range requires review` in `test/matching.test.ts` and `test/resolve.test.ts`.
- [ ] Run focused tests and confirm scalar-only matching rejects the new valid in-range cases.
- [ ] Add `DurationRange` with inclusive `minSec` and `maxSec`; keep `durationSec` when sources agree, and set it to null with `durationRange` when they disagree. Set `durationReview` when range width exceeds the Task 1 limit.
- [ ] Pass candidates when they are inside `[minimum − 1, maximum + 1]`, inclusive, and retain all existing date and identity gates.
- [ ] Prevent automatic links for `durationReview` releases and show the existing REVIEW state in the dashboard.
- [ ] Display a range clearly in the dashboard and API; keep single-value releases displayed as they are today.

**Deliverable:** Duration disagreement is visible and range-aware without weakening identity or date checks.

## Task 7: Remove targeted naming and documentation bloat

**Files:** Rename ambiguous local variables in changed ingestion/merge code; edit `README.md`, `AGENTS.md`, and completed docs under `docs/superpowers/` and `.hermes/plans/` only after checking whether each is still active.

- [ ] Rename ambiguous locals such as `all`, `lanes`, `raw`, `merged`, `match`, `p`, and `prior` to one descriptive word that identifies their role in context.
- [ ] Trim historical narration from comments in touched files after tests cover behavior; preserve contracts, safety rules, and non-obvious decisions.
- [ ] Shorten the README to setup, supported behavior, configuration, and a concise architecture overview. Keep agent-only rules out of it and make one document authoritative for shared matching/deployment facts.
- [ ] Archive or remove only completed planning/scratch docs with no ongoing reference value; do not remove active prompts or decisions needed to operate the app.
- [ ] Check Markdown links and headings, and run `npm run format:check` for files it covers.

**Deliverable:** The changed code and docs use consistent vocabulary and retain only useful explanation.

## Task 8: Full verification and review

**Files:** No additional files unless verification finds a defect.

- [ ] Run `npm run typecheck`, `npm run lint`, and `npm run format:check`.
- [ ] Run `npm test` and fix regressions in the owning task.
- [ ] Start the app with boot sync disabled and a temporary database; confirm it serves the dashboard and health route without requiring live source calls.
- [ ] Inspect API and dashboard output for one merged release, field provenance, studio alias, and duration range.
- [ ] Review the complete diff for accidental deployment changes, secret values, unresolved merge markers, stale comments, and inconsistent variable names.
- [ ] Report any blocked Bang parser work if the required URL/sample was not provided or could not be verified; do not claim full Bang ingestion works without evidence.

**Deliverable:** Local checks pass, the app boots, and remaining evidence gaps are stated plainly.
