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
- Route Sxyprn requests through one small external relay in a fixed, verified country; confirm a real Sxyprn response because IP-country lookups alone do not prove access.
- The relay only accepts the Sxyprn lookup inputs required by Liszt; it never fetches arbitrary user-supplied destinations and never logs credentials or page bodies.
- Do not rotate relay addresses or countries automatically. If Sxyprn blocks the route, stop requests through the existing spacing and circuit breaker and report the sanitized failure.
- Do not change Render settings or trigger a Render deployment.
- Do not provision or deploy the relay or change any hosting settings from this repository workflow. Relay hosting is a separate owner-run step that needs its own provider choice and live verification.
- Hatchable imports, project settings, live scheduled runs, and live log checks are owner-run steps; this repository plan prepares the files and verification instructions but does not operate the external project.
- Before GitHub visibility changes, remove personal identifiers and secrets from current files and every Git ref; history rewrite changes commit IDs.

## Review Focus

- A provider times out or returns malformed data: keep other providers' good data and record a sanitized failure. Test in Tasks 4 and 6.
- A refresh stops midway or is invoked twice: resume without duplicate or lost records. Test in Tasks 3 and 6.
- An optional provider has no secret configured: skip/report it safely without exposing credentials or breaking the rest of the refresh. Test in Task 4.
- A scene has ambiguous or incomplete playback evidence: keep existing safety rules and do not create an unverified link. Test in Task 5.
- A loggable error contains a credential-bearing URL or provider payload: redact/omit it before native logging. Test in Task 6.

---

## File map

The Hatchable project will add `hatchable.toml`, `api/`, `lib/`, `migrations/`, `mcp/`, and `public/` files. A small separate Node HTTP service will handle only Sxyprn lookup traffic because Hatchable's outbound route was region-blocked and its runtime cannot use the current optional package. Existing `src/` and `test/` remain the behavior reference until the Hatchable version is verified; remove the obsolete app Node runtime and Render-specific repository setup only in the final port/documentation task. Keep the existing tests and fixtures as the source for parity tests; add focused Hatchable tests alongside them where the SDK allows local testing.

## Task 1: Prove the Hatchable project shape in a private pilot

**Files:**
- Create: `hatchable.toml`
- Create: `api/health.js`, `api/heartbeat.js`, `api/log-check.js`
- Create: `migrations/0001_pilot.sql`
- Create: `lib/pilot.js`
- Create: `public/pilot/index.html` (keeps the test page away from Liszt's existing homepage)
- Test: `test/hatchable-pilot.test.js`

**Interfaces:**
- Produces: a documented pilot result showing project setup and file upload, a JavaScript route, Postgres migration/read/write, static asset delivery, scheduled-job registration and invocation, one public no-key provider request, and captured logs through `view_logs`. GitHub import is deferred to Task 8 because the repository remains private until its privacy audit passes.

- [x] Confirm the current Hatchable project layout, database, scheduled handler, HTTP, and logs APIs from Hatchable's own documentation and available in-product tools. Record exact entry points and limits in the pilot test notes; do not infer them from this plan.
- [x] Create the smallest private pilot using those documented entry points. It must write and read one disposable database row, return a health response, serve a static page, and log a deliberately handled sample failure without secrets.
- [x] Configure the hourly job and confirm Hatchable lists it as active. Invoke the handler as the scheduler through `run_function`; this is Hatchable's documented scheduler verification. Record that one real clock-triggered firing remains for Task 8. Use the public Eporner record endpoint, which needs no key.
- [x] Inspect native logs through the connected Hatchable `view_logs` tool, verify declared route access, and record whether a separate collaborator role was tested. Do not rely on the severity filter for caught failures: a successful request can be labeled `info` even when `console.error` output is present; verify the structured message is searchable in `log_output`.
- [x] Run the pilot checks in Hatchable. Mark each behavior pass, fail, or unverified with evidence.
- [x] Continue: import is deferred to Task 8; Postgres, handler invocation, outbound fetch, route access, static page, and searchable native logs passed. Automatic clock-triggered firing remains unverified until Task 8.

## Task 2: Port release identity, merge, and matching rules

**Files:**
- Create: `lib/release-identity.js`
- Create: `lib/release-merge.js`
- Create: `lib/matching.js`
- Create: type declarations for those three JavaScript modules, used by the existing TypeScript parity tests
- Test: Hatchable-compatible tests corresponding to `test/release-identity.test.ts`, `test/release-merge.test.ts`, and `test/matching.test.ts`

**Interfaces:**
- Consumes: existing behavior and fixtures from the three named tests and `src/pipeline/release-identity.ts`, `src/pipeline/release-merge.ts`, and `src/core/matching.ts`.
- Produces: plain JavaScript functions with the same input/output behavior as the existing `releaseIdentity`, `mergeRelease`, and matching exports; no Node imports or package dependencies.

- [x] Port the test cases first and verify they fail against the new files because the exports are absent.
- [x] Port only the pure logic needed by the Hatchable app, retaining date, identity, deduplication, and ambiguity rules.
- [x] Run the new tests and the existing matching/release tests; expected: all parity assertions pass.
- [x] Commit this task as `feat: port release matching rules to Hatchable`.

## Task 3: Add persistent Postgres storage and migrations

**Files:**
- Create: `migrations/0001_liszt.sql` and later numbered migrations only when needed
- Create: `lib/store.js`
- Create: temporary `api/store-check.js` for private-project integration checks; remove it in Task 7
- Modify: `package.json` so the standard test command includes Hatchable JavaScript tests
- Test: Hatchable-compatible store and migration tests corresponding to `test/store-migrations.test.ts`, `test/store-transactions.test.ts`, `test/migrations.test.ts`, and `test/fc2-link-persistence.test.ts`

**Interfaces:**
- Consumes: Task 1's confirmed Hatchable database API and Task 2's release identity.
- Produces: store operations matching the current SQLite store responsibilities: source snapshots, provider observations, scenes, source state, run history, pool videos/progress, and FC2 candidates. Use Hatchable's native Postgres access patterns confirmed in Task 1.

- [x] Translate each current migration in `src/core/store/migrations/` into the smallest equivalent Postgres schema; review constraints and indexes against each current store query.
- [x] Write tests for empty initialization, unique scene identity, provider provenance, transaction rollback, refresh progress, and pool/FC2 persistence; confirm failure before implementation.
- [x] Implement the store methods used by the app, keeping the established names and behavior where practical.
- [x] Run the store and migration parity tests against a fresh pilot database; expected: empty start, writes survive later invocations, and rollback leaves no partial update.
- [x] Commit this task as `feat: add Hatchable Postgres storage`.

## Task 4: Port feed fetching, configuration, and source adapters

**Files:**
- Create: `lib/fetcher.js`
- Create: `lib/config.js`
- Create: `lib/sources/*.js` for the adapters in the confirmed spec
- Test: Port the relevant existing tests and fixtures from `test/fetcher.test.ts`, `test/registry.test.ts`, `test/*source*.test.ts`, and provider-specific source tests

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: provider adapters that return the same normalized records and source status expected by the current merge/sync path for Traxxx watchlist, TPDB, ManyVids, Maximo/Fansly, Bang! Originals, FC2CMADB, Madouqu, and Woodman Casting X via Traxxx.

- [x] Add adapter parity tests from existing fixtures, including malformed responses, no-key providers, and optional-secret absence.
- [x] Port the HTTP fetch behavior using Hatchable-supported outbound requests; preserve timeouts, concurrency limits, and retry/error classification only where they are needed to match existing behavior and platform limits.
- [x] Wire optional secrets through Hatchable secret settings and confirm missing keys do not appear in errors or logs.
- [x] Verify adapter behavior with fixtures and the private pilot; report the keyed TPDB provider unverified because no key is configured.
- [x] Commit this task as `feat: port catalogue source adapters`.

## Task 5: Port playback lookup and add the Sxyprn relay

**Files:**
- Create: `lib/tubes/*.js`
- Create: `relay/package.json`, `relay/server.js`, `relay/README.md`
- Modify: `eslint.config.js`
- Test: Port relevant cases from `test/eporner.test.ts`, `test/eporner-pool.test.ts`, `test/fc2-eporner.test.ts`, `test/resolve.test.ts`, `test/reverify.test.ts`, and `test/sxyprn.test.ts`
- Test: `test/sxyprn-relay.test.js`

**Interfaces:**
- Consumes: Tasks 2–4 and the current scene/source types.
- Produces: verified-link behavior for the Eporner trusted pool and FC2 Eporner lookup; the Hatchable Sxyprn client calls an authenticated, narrowly scoped external relay, which uses the existing Sxyprn package outside Hatchable.

- [x] Port fixture-backed safety tests first, including ambiguous title/duration and removed or unsafe video cases.
- [x] Implement Eporner pool, FC2 lookup, and link re-verification with the existing safety thresholds and no Node-only imports.
- [x] Add failing relay tests for its allowed search and details inputs, required shared secret, invalid Sxyprn URLs, arbitrary destinations, upstream errors, response size and timeout limits, and absence of secrets or page bodies in logs.
- [x] Implement the smallest Node HTTP relay around the existing `sxyprn` package. It accepts only search text or a validated `https://sxyprn.com/post/...` URL, constructs the upstream request itself, and returns only the fields used by the existing matcher.
- [x] Add failing Hatchable-client tests proving it calls only the configured relay, sends its secret in an authorization header, and maps a relay block/timeout into the existing failure and circuit-breaker path.
- [x] Implement the Hatchable Sxyprn client using supported `fetch`; keep the existing 10-second spacing, one request at a time, timeout, and circuit-breaker behavior. Never add geolocation-based country guessing or address rotation.
- [x] Add a short owner setup note listing the relay's required runtime, start command, fixed-region requirement, endpoint URL, and secret setting name. Do not include credentials or claim a provider is selected.
- [ ] Stop before live hosting setup. The owner must choose and launch a host in a fixed region, then perform the live check separately. Spain is the first candidate based on one observed success. Record provider, region, cost, egress address, date, and exact result before cutover; if no candidate passes, Sxyprn remains unavailable.
- [x] Run the playback parity tests; expected: no unverified match is persisted.
- [x] Run the relay's local security and behavior tests; expected: authorized allowed lookups work, invalid destinations are rejected, upstream failures are bounded, and no sensitive response content is logged.
- [x] Commit this task as `feat: port verified playback lookup`.

## Task 6: Add bounded sync, hourly scheduling, routes, and native failure logs

**Files:**
- Create: `api/refresh.js`
- Create: `api/cron.js`
- Create: `api/worker.js`, `api/scenes.js`, `api/progress.js`
- Create: `api/status.js`
- Create: `lib/sync.js`
- Create: `lib/refresh.js`, `lib/refresh-jobs.js`, `migrations/0002_refresh_jobs.sql`
- Create: `lib/logging.js`
- Modify: `lib/config.js`, `hatchable.toml`, `eslint.config.js`
- Test: port tests from `test/sync.test.ts`, `test/progress.test.ts`, `test/scheduler.test.ts`, and `test/http.test.ts`

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: one refresh flow callable by manual route and hourly scheduled handler. A persistent job row coalesces duplicate triggers; a Hatchable one-shot worker runs the full idempotent cycle and an expired lease permits replay after interruption. Status and catalogue routes retain current user-facing fields. `logProviderFailure({runId, provider, stage, occurredAt, summary})` writes sanitized structured output to Hatchable's native logs.

- [x] Add tests for manual and scheduled requests sharing one persistent queued job, duplicate claims, async storage, and sanitized provider failure logging.
- [x] Port the existing sync pipeline to await Hatchable's Postgres storage and preserve provider isolation, release merging, playback matching, and link verification.
- [x] Add a shared hourly/manual queue and a one-shot worker. Hatchable documents roughly 310 seconds for one-shot work; completed database writes survive interruption, and an expired 10-minute lease allows the next hourly or manual attempt to replay the idempotent cycle.
- [x] Implement the catalogue, progress, status, manual refresh, and hourly scheduler routes.
- [ ] Verify deployed native function errors and handled provider failures using `view_logs`; owner-run verification remains pending. Search `log_output` rather than assuming the severity filter labels successful requests as errors.
- [x] Commit this task as `feat: add scheduled Hatchable refresh`.

## Task 7: Move the browser experience and remove obsolete runtime claims

**Files:**
- Create: `public/pilot/index.html` (keeps the test page away from Liszt's existing homepage), `public/app.js`, `public/styles.css`, and only the static assets actually required
- Modify: `hatchable.toml`, `README.md`, `package.json`, `.github/workflows/ci.yml`, and Render-specific tracked configuration/docs after confirming their exact presence and references
- Delete: pilot-only `api/health.js`, `api/heartbeat.js`, `api/log-check.js`, `api/store-check.js`, `lib/pilot.js`, `migrations/0001_pilot.sql`, `public/pilot/index.html`, and pilot-only tests before the final app deployment
- Test: browser/catalogue tests corresponding to `test/catalogues.test.ts`, `test/read-model-watchlist.test.ts`, `test/source-health.test.ts`, plus `npm run format:check`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: the current catalogue, source health, sync progress, and manual refresh experience served as Hatchable static assets and routes; documentation describes only verified Hatchable behavior.

- [ ] Port the browser behavior and UI checks, preserving current catalogue grouping and health states.
- [ ] Remove the pilot-only routes and store-check route, helper, migration, static page, and tests; Task 1 uses a separate project, and these probe files must not ship in the final app.
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

- [ ] Give the owner exact steps to import the finished branch into a private Hatchable project and check fresh database creation, static UI, manual refresh, hourly scheduling, feed behavior, resumability, and logs. Verify keyed integrations only when the owner has configured their secrets inside Hatchable. Record each result from evidence the owner provides; mark anything not supplied unverified.
- [ ] After the owner has separately launched the relay in a fixed region and confirmed a real Sxyprn response, the owner adds its URL and secret in Hatchable's secret settings. Verify Hatchable-to-relay authentication and a real Sxyprn search and details lookup without viewing or printing the secret. If this owner-run step has not happened, report the relay integration as pending and do not claim Sxyprn works.
- [ ] Confirm Hatchable pull creates a reviewable draft and promotion requires a human action. Do not promote or publish the app without the owner's separate decision.
- [ ] Scan tracked files, ignored/untracked files intended for release, every Git ref, and Git metadata for personal names, email addresses, personal domains, and secrets. Remove matches from current content and history while preserving messages, timestamps, and file content except approved personal-data removals.
- [ ] Re-scan the rewritten history and current tree; expected: no matches. Record the new default-branch commit and warn that existing clones must be recreated.
- [ ] Make the GitHub repository public only after the clean scan; verify its visibility and default-branch contents from GitHub.
- [ ] Import the public default branch into Hatchable and verify the app remains private and its database is fresh.
- [ ] Commit any final source changes before the history rewrite; do not add a follow-up commit that reintroduces old author metadata.

## Plan self-review

- **Spec coverage:** pilot and platform limits (Task 1); release/matching behavior (Task 2); persistent data (Task 3); named feeds/secrets (Task 4); playback integrations and constrained Sxyprn relay (Task 5); hourly/manual refresh, progress, logs and routes (Task 6); browser app and hosting documentation (Task 7); private verification, PII/history cleanup and public release (Task 8).
- **Step clarity:** each task defines files, producer/consumer interfaces, a test or live check, expected outcome, and commit boundary. Hatchable SDK entry points are intentionally verified during Task 1 rather than guessed in advance.
- **Type/interface consistency:** store and route implementations depend on Task 1's discovered SDK API; later tasks consume normalized source records and persisted progress from earlier tasks. No unverified Hatchable function signature is invented here.
- **Review focus coverage:** provider errors, interrupted/duplicate refresh, missing secrets, ambiguous playback evidence, relay authorization/destination validation, and sensitive log content are assigned tests to their owning tasks.
- **Proportion:** eight reviewable stages match the full platform move and release gate; the pilot and privacy release are explicit blockers, not assumed successes.
