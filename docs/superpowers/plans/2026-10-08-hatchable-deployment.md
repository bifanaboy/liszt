# Hatchable Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Liszt into a private Hatchable project with persistent per-project PostgreSQL storage, hourly and manual refresh, the current catalogue behavior, and Hatchable-native failure logs; publish the GitHub repository only after current files and all history pass a privacy audit.

**Architecture:** First run a small private Hatchable pilot to prove the platform shape and limits. If it passes, move the existing plain-JavaScript domain behavior, source adapters, storage, sync work, and browser interface into Hatchable's file-based project layout. Keep the first release empty of old Render data and treat public GitHub release as a final gated step after history cleanup.

**Tech Stack:** Hatchable JavaScript handlers and SDK, Hatchable PostgreSQL, SQL migrations, browser JavaScript, existing Node.js/TypeScript test suite as behavior reference during the port.

**Spec:** `docs/superpowers/specs/2026-10-08-hatchable-deployment-design.md`

## Global Constraints

- Hourly automatic refresh and the existing manual refresh action use the same sync path.
- Each Hatchable project starts with an empty database; do not migrate Render data.
- Use Hatchable native execution logs and `view_logs`; do not add a separate error table or error page.
- Keep feed secrets in Hatchable secret settings; never put them in source or logs.
- Keep the Hatchable project private by default; GitHub merges require manual pull, draft review, and human promotion.
- Preserve named provider integrations and matching safety unless a pilot proves a platform limit; pause for a scope decision before dropping any integration.
- Do not change Render settings or trigger a Render deployment.
- Before GitHub visibility changes, remove personal identifiers and secrets from current files and every Git ref; history rewrite changes commit IDs.

## Review Focus

- A provider times out or returns malformed data: keep other providers' good data and record a sanitized failure. Test in Tasks 4 and 6.
- A refresh stops midway or is invoked twice: resume without duplicate or lost records. Test in Tasks 3 and 6.
- An optional provider has no secret configured: skip/report it safely without exposing credentials or breaking the rest of the refresh. Test in Task 4.
- A scene has ambiguous or incomplete playback evidence: keep existing safety rules and do not create an unverified link. Test in Task 5.
- A loggable error contains a credential-bearing URL or provider payload: redact/omit it before native logging. Test in Task 6.

---

## File map

The Hatchable project will add `hatchable.toml`, `api/`, `lib/`, `migrations/`, `mcp/`, and `public/` files. Existing `src/` and `test/` remain the behavior reference until the Hatchable version is verified; remove the obsolete Node runtime and Render-specific repository setup only in the final port/documentation task. Keep the existing tests and fixtures as the source for parity tests; add focused Hatchable tests alongside them where the SDK allows local testing.

## Task 1: Prove the Hatchable project shape in a private pilot

**Files:**
- Create: `hatchable.toml`
- Create: `api/health.js`
- Create: `migrations/0001_pilot.sql`
- Create: `lib/pilot.js`
- Test: `test/hatchable-pilot.test.js`

**Interfaces:**
- Produces: a documented pilot result showing project import, a JavaScript route, Postgres migration/read/write, static asset delivery, scheduled-job registration, one public no-key feed request, and `view_logs` visibility for owner and authorized agent.

- [ ] Confirm the current Hatchable project layout, database, scheduled handler, HTTP, and logs APIs from Hatchable's own documentation and available in-product tools. Record exact entry points and limits in the pilot test notes; do not infer them from this plan.
- [ ] Create the smallest private pilot using those documented entry points. It must write and read one disposable database row, return a health response, serve a static page, and log a deliberately handled sample failure without secrets.
- [ ] Configure a scheduled job and verify that it starts once within Hatchable's confirmed job limits. Use only a public feed that needs no key.
- [ ] Inspect native logs as the owner and with an already-authorized connected agent; record what each can see and whether retention is stated by the product.
- [ ] Run the pilot checks in Hatchable. Mark each behavior pass, fail, or unverified with evidence.
- [ ] Stop before the full port if import, Postgres, scheduling, outbound fetch, or native log access cannot meet the spec; return the specific failure for a scope decision.

## Task 2: Port release identity, merge, and matching rules

**Files:**
- Create: `lib/release-identity.js`
- Create: `lib/release-merge.js`
- Create: `lib/matching.js`
- Test: Hatchable-compatible tests corresponding to `test/release-identity.test.ts`, `test/release-merge.test.ts`, and `test/matching.test.ts`

**Interfaces:**
- Consumes: existing behavior and fixtures from the three named tests and `src/pipeline/release-identity.ts`, `src/pipeline/release-merge.ts`, and `src/core/matching.ts`.
- Produces: plain JavaScript functions with the same input/output behavior as the existing `releaseIdentity`, `mergeRelease`, and matching exports; no Node imports or package dependencies.

- [ ] Port the test cases first and verify they fail against the new files because the exports are absent.
- [ ] Port only the pure logic needed by the Hatchable app, retaining date, identity, deduplication, and ambiguity rules.
- [ ] Run the new tests and the existing matching/release tests; expected: all parity assertions pass.
- [ ] Commit this task as `feat: port release matching rules to Hatchable`.

## Task 3: Add persistent Postgres storage and migrations

**Files:**
- Create: `migrations/0001_liszt.sql` and later numbered migrations only when needed
- Create: `lib/store.js`
- Test: Hatchable-compatible store and migration tests corresponding to `test/store-migrations.test.ts`, `test/store-transactions.test.ts`, `test/migrations.test.ts`, and `test/fc2-link-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1's confirmed Hatchable database API and Task 2's release identity.
- Produces: store operations matching the current SQLite store responsibilities: source snapshots, provider observations, scenes, source state, run history, pool videos/progress, and FC2 candidates. Use Hatchable's native Postgres access patterns confirmed in Task 1.

- [ ] Translate each current migration in `src/core/store/migrations/` into the smallest equivalent Postgres schema; review constraints and indexes against each current store query.
- [ ] Write tests for empty initialization, unique scene identity, provider provenance, transaction rollback, refresh progress, and pool/FC2 persistence; confirm failure before implementation.
- [ ] Implement the store methods used by the app, keeping the established names and behavior where practical.
- [ ] Run the store and migration parity tests against a fresh pilot database; expected: empty start, writes survive later invocations, and rollback leaves no partial update.
- [ ] Commit this task as `feat: add Hatchable Postgres storage`.

## Task 4: Port feed fetching, configuration, and source adapters

**Files:**
- Create: `lib/fetcher.js`
- Create: `lib/config.js`
- Create: `lib/sources/*.js` for the adapters in the confirmed spec
- Test: Port the relevant existing tests and fixtures from `test/fetcher.test.ts`, `test/registry.test.ts`, `test/*source*.test.ts`, and provider-specific source tests

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: provider adapters that return the same normalized records and source status expected by the current merge/sync path for Traxxx watchlist, TPDB, ManyVids, Maximo/Fansly, Bang! Originals, FC2CMADB, Madouqu, and Woodman Casting X via Traxxx.

- [ ] Add adapter parity tests from existing fixtures, including malformed responses, no-key providers, and optional-secret absence.
- [ ] Port the HTTP fetch behavior using Hatchable-supported outbound requests; preserve timeouts, concurrency limits, and retry/error classification only where they are needed to match existing behavior and platform limits.
- [ ] Wire optional secrets through Hatchable secret settings and confirm missing keys do not appear in errors or logs.
- [ ] Verify each adapter with fixtures, then use the private pilot for live checks only where credentials are already configured by the owner; report keyed providers as unverified if not configured.
- [ ] Commit this task as `feat: port catalogue source adapters`.

## Task 5: Port playback lookup and link verification

**Files:**
- Create: `lib/tubes/*.js`
- Test: Port relevant cases from `test/eporner.test.ts`, `test/eporner-pool.test.ts`, `test/fc2-eporner.test.ts`, `test/resolve.test.ts`, `test/reverify.test.ts`, and `test/sxyprn.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4 and the current scene/source types.
- Produces: verified-link behavior for the Eporner trusted pool and FC2 Eporner lookup, plus Sxyprn detail lookup if the pilot confirms a supported implementation path.

- [ ] Port fixture-backed safety tests first, including ambiguous title/duration and removed or unsafe video cases.
- [ ] Implement Eporner pool, FC2 lookup, and link re-verification with the existing safety thresholds and no Node-only imports.
- [ ] Investigate Sxyprn separately: the current implementation dynamically imports an optional npm package, which Hatchable's documented static-import restriction may not support. Test whether a direct supported HTTP implementation can preserve behavior.
- [ ] If Sxyprn cannot be preserved within confirmed Hatchable limits, stop and ask for a scope decision; do not silently remove or weaken it.
- [ ] Run the playback parity tests; expected: no unverified match is persisted.
- [ ] Commit this task as `feat: port verified playback lookup`.

## Task 6: Add bounded sync, hourly scheduling, routes, and native failure logs

**Files:**
- Create: `api/refresh.js`
- Create: `api/cron.js`
- Create: `api/status.js`
- Create: `lib/sync.js`
- Create: `lib/progress.js`
- Create: `lib/logging.js`
- Test: port tests from `test/sync.test.ts`, `test/progress.test.ts`, `test/scheduler.test.ts`, and `test/http.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: one refresh flow callable by manual route and hourly scheduled handler; bounded steps persist progress in Postgres and can resume safely. Status and catalogue routes retain current user-facing fields. `logProviderFailure({runId, provider, stage, occurredAt, summary})` writes sanitized structured output to Hatchable's native logs.

- [ ] Add tests for manual and scheduled invocations sharing the same sync path, bounded continuation, duplicate invocation, one-provider failure with other providers succeeding, and sanitized failure logging.
- [ ] Implement resumable sync using the confirmed Hatchable job limits; do not assume in-memory timers or a long-running process.
- [ ] Implement manual refresh, scheduled refresh, status, and catalogue routes with the Hatchable request/response interface verified in Task 1.
- [ ] Verify native function errors and handled provider failures using `view_logs`; assert keys, headers, credential-bearing URLs, and raw provider bodies are absent.
- [ ] Commit this task as `feat: add scheduled Hatchable refresh`.

## Task 7: Move the browser experience and remove obsolete runtime claims

**Files:**
- Create: `public/index.html`, `public/app.js`, `public/styles.css`, and only the static assets actually required
- Modify: `README.md`, `package.json`, `.github/workflows/ci.yml`, and Render-specific tracked configuration/docs after confirming their exact presence and references
- Test: browser/catalogue tests corresponding to `test/catalogues.test.ts`, `test/read-model-watchlist.test.ts`, `test/source-health.test.ts`, plus `npm run format:check`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: the current catalogue, source health, sync progress, and manual refresh experience served as Hatchable static assets and routes; documentation describes only verified Hatchable behavior.

- [ ] Port the browser behavior and UI checks, preserving current catalogue grouping and health states.
- [ ] Remove production reliance on the Node HTTP server, TypeScript build, local filesystem database, and optional runtime package only after all Hatchable behavior is covered.
- [ ] Remove or revise Render setup and hosting claims in the repository; do not access or change the live Render service.
- [ ] Update the README with verified Hatchable setup, secrets, refresh, logs, empty initial data, and manual GitHub-pull promotion behavior.
- [ ] Run the full remaining test suite and `npm run format:check`; expected: pass, or document each deliberately replaced Node-only test with equivalent Hatchable coverage.
- [ ] Commit this task as `feat: serve Liszt from Hatchable`.

## Task 8: Verify privately, scrub all history, then publish the repository

**Files:**
- Modify: `prompts/product-audit.md` and any other current files found by the privacy scan
- History: all Git refs, with author and committer metadata replaced by neutral project identities

**Interfaces:**
- Consumes: Tasks 1–7 and the release sequence in the spec.
- Produces: verified private Hatchable draft and a public GitHub repository whose current files and rewritten history contain no personal identifiers or secrets.

- [ ] Deploy/import the finished branch into a private Hatchable project; check fresh database creation, static UI, manual refresh, hourly scheduling, feed behavior, resumability, and logs. Verify keyed integrations only when the owner has supplied their secrets inside Hatchable. Record the observed outcome for each in-scope provider.
- [ ] Confirm Hatchable pull creates a reviewable draft and promotion requires a human action. Do not promote or publish the app without the owner's separate decision.
- [ ] Scan tracked files, ignored/untracked files intended for release, every Git ref, and Git metadata for personal names, email addresses, personal domains, and secrets. Remove matches from current content and history while preserving messages, timestamps, and file content except approved personal-data removals.
- [ ] Re-scan the rewritten history and current tree; expected: no matches. Record the new default-branch commit and warn that existing clones must be recreated.
- [ ] Make the GitHub repository public only after the clean scan; verify its visibility and default-branch contents from GitHub.
- [ ] Import the public default branch into Hatchable and verify the app remains private and its database is fresh.
- [ ] Commit any final source changes before the history rewrite; do not add a follow-up commit that reintroduces old author metadata.

## Plan self-review

- **Spec coverage:** pilot and platform limits (Task 1); release/matching behavior (Task 2); persistent data (Task 3); named feeds/secrets (Task 4); named playback integrations and Sxyprn decision gate (Task 5); hourly/manual refresh, progress, logs and routes (Task 6); browser app and hosting documentation (Task 7); private verification, PII/history cleanup and public release (Task 8).
- **Step clarity:** each task defines files, producer/consumer interfaces, a test or live check, expected outcome, and commit boundary. Hatchable SDK entry points are intentionally verified during Task 1 rather than guessed in advance.
- **Type/interface consistency:** store and route implementations depend on Task 1's discovered SDK API; later tasks consume normalized source records and persisted progress from earlier tasks. No unverified Hatchable function signature is invented here.
- **Review focus coverage:** provider errors, interrupted/duplicate refresh, missing secrets, ambiguous playback evidence, and sensitive log content are assigned tests to their owning tasks.
- **Proportion:** eight reviewable stages match the full platform move and release gate; the pilot and privacy release are explicit blockers, not assumed successes.
