# Issue 9 — Add the 20 missing studio lanes without importing foreign releases

## Goal

Extend the Traxxx watchlist default (`LISZT_TRAXXX_WATCHLIST`) with 20 studio lanes listed in GitHub issue #9, so that the app discovers releases from those studios on every sync. The title's safeguard "without importing the wrong releases" must remain enforced by the existing filter guards (entity, tag, per-record). The live Render deployment must not break, and the free-tier request budget must stay within measured limits.

## Architecture

The watchlist lives in `src/sources/traxxx-watchlist.ts` as the `TRAXXX_WATCHLIST` readonly string array. Each URL is parsed by `parseTraxxxListingUrl` into a `{id, kind, slug, tags}` record, then fed to `createTraxxxWatchlistStudios` which produces `SourceAdapter` entries injected into the source registry (`src/sources/registry.ts`). The registry's `createSources` function adds the watchlist lanes after the first three canonical sources (`lancelotStylesEvolution`, `mamboPerv`, `maximoGarcia`) and before `WoodmanCastingXSource`.

### Measured evidence (2026-10-04, direct traxxx.me API queries)

| lane (as written in issue) | kind | untagged total | tags=anal total | first record entity slug match | notes |
|---|---|---|---|---|---|
| channel/elegantangel/scenes/latest/1?tags=anal | channel | 9000 | 846 | True | OK |
| network/brazzers/scenes/latest/1?tags=anal | network | 12552 | 2794 | True | OK |
| network/bangbros/scenes/latest/1?tags=anal | network | 12284 | 1532 | True | OK |
| channel/lancelotstyles/scenes/latest/1?tags=anal | channel | 424 | 422 | True | **DUPLICATE** — already hardcoded as `lancelotStylesEvolution` in registry |
| channel/natashateenfilms/scenes/latest/1?tags=anal | channel | 482 | 475 | True | OK |
| channel/mamboperv/scenes/latest/1?tags=anal | channel | 788 | 750 | True | **DUPLICATE** — already hardcoded as `mamboPerv` in registry |
| channel/disciplesofdesire/scenes/latest/1?tags=anal | channel | 464 | 83 | True | OK |
| network/bang/scenes/latest/1?tags=anal | network | 2735 | 381 | True | OK |
| network/mikeadriano/scenes/latest/1?tags=anal | network | 1962 | 888 | True | OK |
| channel/hookuphotshot/scenes/latest/1?tags=anal | channel | 494 | 132 | True | OK |
| network/julesjordan/scenes/latest/1?tags=anal | network | 4097 | 1861 | True | OK |
| network/xempire/scenes/latest/1?tags=anal | network | 2150 | 788 | True | OK |
| network/teamskeet/scenes/latest/1?tags=anal | network | 6488 | 347 | True | OK |
| network/pervcity/scenes/latest/1?tags=anal | network | 1889 | 1440 | True | OK |
| channel/rickysroom/scenes/latest/1?tags=anal | channel | 151 | 23 | True | OK |
| network/firstanalquest/scenes/latest/1?tags=anal | network | 904 | 806 | True | OK |
| channel/wakeupnfuck/scenes/latest/1?tags=anal | channel | 123 | 115 | True | OK |
| channel/tokyohot/scenes/latest/1?tags=anal | channel | 3527 | 591 | True | OK |
| network/exploitedx/scenes/latest/1?tags=anal | network | 2826 | 395 | True | OK |
| channel/herlimit/scenes/latest/1?tags=anal | channel | 332 | 299 | True | OK |
| network/darkkotv/scenes/latest/1?tags=anal | **network** (WRONG kind) | **528826** | **122783** | **False** (first record has channel not network) | **Catastrophic** — kind=network returns the entire ~500k index; the entity filter was silently ignored. Must change to `channel/darkkotv`. |

| bare URL (no ?tags=anal) | kind | untagged total | tagged (with ?tags=anal) | notes |
|---|---|---|---|---|
| channel/lancelotstyles/ | channel | 424 | 422 with tags added | **DUPLICATE** — same as existing registry source |
| channel/natashateenfilms/ | channel | 482 | 475 with tags added | OK |
| channel/mamboperv/ | channel | 788 | 750 with tags added | **DUPLICATE** — same as existing registry source |
| network/firstanalquest/ | network | 904 | 806 with tags added | OK (kind confirmed as network) |
| channel/wakeupnfuck/ | channel | 123 | 115 with tags added | OK |
| channel/herlimit/ | channel | 332 | 299 with tags added | OK |

**Darkko TV correction:** The issue lists `network/darkkotv` but traxxx classifies Darkko TV as a **channel** (`darkkotv`). Using the network namespace silently returns the full ~528k-scene index because the `e=` filter is unknown for that namespace, and the guard's count comparison (`firstPage.total === baseline`) passes because tagged=122783 !== untagged=528826, but per-record `sceneMatchesEntity` then filters every record to 0 since all records have `channel.slug=darkkotv`, not `network.slug`. The fix: rewrite the watchlist entry as `channel/darkkotv/scenes/latest/1?tags=anal`.

### Tag-filter guard fragility (post-measurement)

The `assertFilterApplies` function in `src/sources/traxxx.ts` compares `firstPage.total` against `baseline` (entityTotal when tags supplied, unfilteredTotal otherwise). If the values are equal, it throws "tag filter was ignored". Measured margins are razor-thin: lancelotstyles 422 vs 424 (2-scene margin), natashateenfilms 475 vs 482 (7), mamboperv 750 vs 788 (38). These gaps could close if traxxx's tagging changes, causing the guard to falsely fire and the lane to retain only last-good records permanently. A stronger defence: assert **per-record** that every returned scene carries the filter tag in its `tags[].slug` array. This is strictly stronger than the count comparison and eliminates the latent fragility.

## Tech Stack

- Node.js 24, TypeScript
- `src/sources/traxxx-watchlist.ts` — URL parsing, watchlist → SourceAdapter creation
- `src/sources/traxxx.ts` — `assertFilterApplies`, entity/per-record guards, `createTraxxxStudio`
- `src/sources/registry.ts` — `createSources` injects watchlist lanes
- `src/config.ts` — `LISZT_TRAXXX_WATCHLIST` env var, defaults to built-in
- `README.md` lane table documents the grammar

## Global Constraints

- Do not add Stash as a runtime dependency (per AGENTS.md §1)
- Do not change Render deployment config or add a persistent disk (§3)
- Do not request, retrieve, store, rotate, or revoke credentials (§1)
- Keep the existing matching gates, date window (±1s duration, ±2-day window), and rung behaviour
- Keep `TRAXXX_WATCHLIST` as a comma-separated list of traxxx page URLs; the parser grammar must not be loosened — the `/(?:\?.*)?` guard that enforces `/network|channel/<slug>/scenes/latest/1` format must remain, because loosening it re-introduces the darkkotv /network/ namespace hole
- Do not modify any secret or environment value on behalf of the user; this plan only touches the repository default (the env var `LISZT_TRAXXX_WATCHLIST` can still be overridden per-deploy)

## Review Focus

- `parseTraxxxListingUrl` must continue to reject URLs that do not match the exact `/network|channel/<slug>/scenes/latest/1` path structure — the darkkotv incident proves why
- The tag-filter guard should assert **per-record** that the returned scene carries the tag `anal` in `tags[].slug`, not merely compare totals — eliminates the 2-scene margin fragility
- The 2 duplicate-lane exclusions (lancelotstyles and mamboperv) must not appear in the default watchlist; they are already ingested as hardcoded registry sources and would create duplicate scene rows (key: `<source-id>:<source-scene-id>`)
- Each new SourceAdapter's authority URL must use the entity filter `e=<slug>` or `e=_<slug>` as produced by `entityFilter(kind, slug)` — not derived from the raw input URL
- `createTraxxxWatchlistStudios` reserved-id check must also cover the new IDs; if `lancelotStylesEvolution` and `mamboPerv` are added to `RETIRED_SOURCE_IDS`, the guard will throw for those two URLs — instead, simply omit them from the default array

## Failure Modes

| What breaks | Why | Fix |
|---|---|---|
| `network/darkkotv` lane ingests nothing or triggers guard | kind=network returns full index; entity filter silently ignored; per-record entity check filters all records to 0 | Rewrite watchlist entry to `channel/darkkotv/scenes/latest/1?tags=anal` |
| Tag-filter guard falsely fires on a studio whose entire catalogue becomes anal-tagged | Count comparison `firstPage.total === baseline` has 2–38 scene margin; if tags saturate, baseline equals tagged total and guard throws | Replace count comparison with per-record tag-assertion in `assertFilterApplies` |
| Duplicate scene rows — two sources ingest the same traxxx channel | lancelotstyles or mamboperv added to watchlist while already hardcoded in registry (key = `<source-id>:<source-scene-id>`) | Omit those two from the default watchlist default array |
| `verifiedEmpty: true` for a lane that actually has scenes | If all records fall outside the rolling 90-day window, the lane emits 0 in-window scenes and is reported verifiedEmpty — accepted behaviour, not a bug |
| Sync hangs or exceeds request budget | Adding 20 lanes multiplies per-cycle traxxx requests; each lane: 1 `unfilteredTotal` + 1 `entityTotal` + up to MAX_PAGES=200 pages of 100 each, but with window=90 days and newest-first pagination, each lane walks ~1–3 pages. Measured total tagged-anal across all 20 lanes ≈15,000 lifetime, so per-cycle volume is bounded. |
| Labels on issue #9 violate §5 (three groups) | Current labels: `question`, `expensive` — missing `feature` and `major` | Relabel to `expensive`, `feature`, `major` |

## Non-Goals

- Do not add Stash as a runtime dependency
- Do not modify Render deployment settings or add a persistent disk
- Do not change the matching gates, duration tolerance, or rung behaviour
- Do not ship code that reads or writes secrets or credentials
- Do not close or reparent Discussion #59 unless the user explicitly requests it

## Acceptance Tests (run after code change)

- `npm run typecheck` passes
- `npm run lint` passes
- `npm run format:check` passes
- `node --test test/traxxx-watchlist.test.ts` — all watchlist tests pass, including:
  - New test: default watchlist array length = 19 (21 issue entries minus 2 duplicates)
  - New test: `lancelotstyles` and `mamboperv` URLs are excluded from the default (omit from array)
  - New test: `network/darkkotv` entry is NOT in the default array; corrected `channel/darkkotv` IS present and resolves to the right kind and slug
  - New test: `createTraxxxWatchlistStudios` with the 19-entry default does not throw Duplicate/Reserved ID errors
  - New test: tag-filter per-record guard fires only when a returned record lacks the `anal` tag; does NOT fire on equal-count scenarios
  - Existing test: `the registry replaces the retired Tushy lane with watchlist lanes` still passes
  - Existing test: watchlist rejects duplicate IDs and reserved IDs still works
- `node --test test/sync.test.ts` — sync run with default watchlist completes without errors, no duplicate scene rows
- `git diff --check` — no whitespace errors
- Labels on issue #9 updated to `expensive`, `feature`, `major` (per §5 requirement)

## Tasks (checkbox format, ordered)

- [ ] Change `TRAXXX_WATCHLIST` default in `src/sources/traxxx-watchlist.ts` from `["https://traxxx.me/network/vixen/scenes/latest/1?tags=anal"]` to a 19-entry array:
  - The 15 issue URLs that already carry `?tags=anal` and have correct kind+slug (keep as-is, the code rewrites them to canonical form)
  - The 4 bare URLs that are kind=network or kind=channel and have no tags: `channel/natashateenfilms/`, `network/firstanalquest/`, `channel/wakeupnfuck/`, `channel/herlimit/` — each without `?tags=anal`
  - Exclude `channel/lancelotstyles/` and `channel/mamboperv/` because those duplicate existing hardcoded registry sources (`lancelotStylesEvolution`, `mamboPerv`)
  - Rewrite `network/darkkotv/` → `channel/darkkotv/` (kind correction; keep `?tags=anal`)
- [ ] In `src/sources/traxxx.ts`, replace the count-comparison in `assertFilterApplies` with a per-record tag assertion: every returned scene must have `anal` present in its `tags[].slug` array; if any record lacks it, throw a controlled error. Keep the count-comparison as a secondary guard for the case of zero returned records.
- [ ] Add `lancelotStylesEvolution` and `mamboPerv` to `RETIRED_SOURCE_IDS` in `src/sources/registry.ts` (value: `["tushy", "lancelot-styles-evolution", "mambo-perv"]`) — the watchlist guard will then reject those two URLs with a Reserved ID error, providing a compile-time safeguard rather than relying on omission from the default array.
- [ ] Update `README.md` lane table (line ~98-121) to list all 19 watchlist entries with their traxxx entity kind and the `anal` tag applicability, and add a note about the Darkko TV namespace correction.
- [ ] Run `npm run typecheck && npm run lint && npm run format:check` — all pass
- [ ] Run `node --test test/traxxx-watchlist.test.ts` — all pass
- [ ] Run `node --test test/sync.test.ts` — sync completes without errors
- [ ] Relabel GitHub issue #9 labels from `question` + `expensive` to `expensive`, `feature`, `major` (per §5 three-group requirement). This is a GitHub UI action, not a code change.
- [ ] Post a summary comment on issue #9 referencing this plan, the measured evidence table, and the actions taken. Close the issue after verification.