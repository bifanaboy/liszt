# Studio-First Release Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Use Traxxx to discover each release and an applicable studio detail scraper as the primary source of its metadata.

**Architecture:** Hydrate Traxxx records from their exact release URLs before SQLite upsert and matching. Merge verified studio fields over Traxxx field-by-field, persist attempt times so work stays bounded, and leave every existing link and source row intact when scraping fails.

**Tech Stack:** Node.js 24, TypeScript, SQLite migrations, existing `Fetcher`, existing source scraper helpers; no added dependency.

**Spec:** [2026-10-03-studio-first-metadata-design.md](../specs/2026-10-03-studio-first-metadata-design.md)

## Global Constraints

- Traxxx remains the release-discovery feed; no studio listing walks.
- A verified studio field wins; Traxxx or a previously scraped value fills a page gap.
- Fetch only HTTPS hosts covered by a matching scraper profile and revalidate redirects.
- Retry an incomplete or failed page at most once per 24 hours; cap work at 50 scenes per sync.
- Keep the existing matching date window and ±1-second duration tolerance.
- No Stash runtime, new dependencies, credentials, or hosting changes.

## Review Focus

- Release URL is a Traxxx page or malformed: skip without fetching.
- Studio page redirects to another host: reject redirect and retain current metadata.
- Studio page identifies another slug: reject the response and retain current metadata.
- Studio returns only some fields: merge field-by-field and preserve earlier studio values.
- 90-day catalogue exceeds the request cap: process due scenes fairly and retry no more than daily.

---

### Task 1: Persist studio-detail attempt times

**Files:**
- Modify: `src/core/schema.ts`
- Modify: `src/core/store/sqlite.ts`
- Create: `src/core/store/migrations/0009_studio_metadata.sql`
- Modify: `src/pipeline/sync.ts`
- Test: `test/sync.test.ts`

**Interfaces:**
- `Scene.studioMetadataCheckedAt: IsoTimestamp.nullable()` records the last detail attempt.
- `normaliseScene(adapter, raw, now, previous, studioMetadataCheckedAt?)` carries it forward unless this sync attempted a scrape.

- [x] Add the nullable scene field and a migration column; map it in SQLite reads, inserts, updates, and bindings.
- [x] Preserve the timestamp when `normaliseScene` receives no new attempt value.
- [x] Add `studio metadata attempt time survives normalization and store round trip`, asserting both an explicit timestamp and preservation on the next normalization.
- [x] Run `node --test test/sync.test.ts` (expected: pass) and `npm run typecheck`.
- [x] Run `git diff --check`.
- [x] Commit as `feat: persist studio metadata check time`.

### Task 2: Add exact-URL studio detail scrapers

**Files:**
- Create: `src/sources/studio-metadata.ts`
- Create: `src/sources/vixen-site.ts`
- Modify: `src/sources/studio-site.ts`
- Test: `test/studio-metadata.test.ts`

**Interfaces:**
- `scrapeReleaseMetadata(releaseUrl: string, fetcher: Fetcher): Promise<Partial<RawScene> | null>` returns only fields verified from the exact page, or `null` for an unsupported or unusable page.
- Host profiles map the nine Vixen family domains to the Vixen GraphQL detail lookup and reuse the existing safe JSON-LD/metadata parser for its currently allowed hosts.
- Vixen responses must contain the exact URL slug requested before their fields are accepted.

- [x] Add `Vixen detail lookup accepts the exact matching video response and rejects a different slug`.
- [x] Run `node --test test/studio-metadata.test.ts` and confirm failure on missing scraper functions.
- [x] Implement strict HTTPS and exact host/profile checks; the Vixen GraphQL lookup does not follow redirects, and the existing page scraper revalidates every redirect.
- [x] Extract supported fields from the exact Vixen detail response, including `runLength`, and mark each returned field as studio-sourced.
- [x] Reuse the existing studio-page extractor for its established hosts.
- [x] Run `node --test test/studio-metadata.test.ts`, `npm run typecheck`, and `git diff --check`.
- [x] Commit as `feat: read release details from studio pages`.

### Task 3: Hydrate, merge, and bound sync work

**Files:**
- Modify: `src/pipeline/sync.ts`
- Modify: `src/core/schema.ts` or `src/sources/studio-metadata.ts` only if the merge helper belongs there.
- Test: `test/sync.test.ts`

**Interfaces:**
- `mergeStudioMetadata(raw: RawScene, page: Partial<RawScene> | null, previous?: Scene): RawScene` applies current page values first, then prior studio-sourced fields, then current Traxxx values.
- Sync reserves a global budget of 50 eligible scenes per cycle. New scenes without attempt times run first; due incomplete scenes use the oldest attempt time first.

- [x] Add sync regression tests for studio precedence, Traxxx fallback, 24-hour retries, and the 50-scene cap; existing link-preservation coverage remains active.
- [x] Run `node --test test/sync.test.ts` and confirm the new precedence behavior fails before implementation.
- [x] Select Traxxx scenes with an applicable profile and no complete set of profile-supported studio fields; retry an incomplete scene only when its previous attempt is at least 24 hours old.
- [x] Apply the global 50-scene budget across source fetches; set the attempt timestamp even when the studio request fails.
- [x] Merge before normalization and upsert; retain provenance and existing link history.
- [x] Mark scenes without a positive duration metadata-poor so the existing `REVIEW` label distinguishes the unresolved gate.
- [x] Run `node --test test/sync.test.ts`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `git diff --check`.
- [x] Commit as `feat: prefer studio metadata during sync`.

### Task 4: Map active studios and document coverage

**Files:**
- Modify: `src/sources/studio-metadata.ts`
- Modify: `README.md` only if the existing source/metadata architecture description becomes inaccurate.
- Test: `test/studio-metadata.test.ts`

**Interfaces:**
- The registry maps every current Traxxx release host with a corresponding Stash scene-detail scraper. Unmatched hosts remain on Traxxx.

- [x] Check the active/default and configurable Traxxx lanes against the current CommunityScrapers tree and scene URL definitions; register the Vixen family and Woodman Casting X, plus the existing SexLikeReal and AnalVids scraper hosts.
- [ ] Leave hosts without a directly applicable scene-detail scraper on Traxxx values.
- [x] Add profile registry coverage for Vixen family, SexLikeReal, AnalVids/PissVids/BustyWorld, and Woodman Casting X; verify Woodman extraction follows its Stash scene fields and has no runtime field.
- [x] Run `node --test test/studio-metadata.test.ts`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `git diff --check`.
- [x] Commit as `feat: map supported studio detail scrapers`.
