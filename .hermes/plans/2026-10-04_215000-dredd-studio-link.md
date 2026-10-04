# Plan: Issue #116 - Collect Dredd's releases from a verified source

## Goal
Add Dredd as a supported studio by resolving his three TPDB sites (OnlyFans, ManyVids, main) under a single unified studio ID 50864 via the existing StudioLink mechanism.

## Current Context / Assumptions
- Issue #116 is OPEN, labeled `feature`, `major`, `needs-intel`, `not urgent`
- Dredd has three TPDB sites per the issue comment:
  - `https://theporndb.net/sites/fansdbdreddxxxonlyfans` (OnlyFans)
  - `https://theporndb.net/sites/manyvidsdredddevastate` (ManyVids)
  - `https://theporndb.net/sites/dreddxxx` (main)
- The comment suggests using studio ID 50864 (TPDB site ID for dreddxxx) as the unified identity
- Existing mechanism: `npm run link-studios` resolves TPDB URLs → StudioLink declaration → `LISZT_STUDIO_LINKS` config
- No code changes needed — this is a configuration task using existing tooling

## Architecture / Proposed Approach
Use the existing `link-studios` CLI to resolve the primary TPDB URL (`dreddxxx`) to confirm site ID 50864. Then create a StudioLink declaration that maps all three TPDB sites to one unified studio with that siteId. Configure via `LISZT_STUDIO_LINKS` environment variable (JSON file or inline). No new adapter required — the TPDB watchlist already pulls by siteId.

## Step-by-Step Tasks

### Task 1: Verify TPDB site IDs for all three Dredd URLs
**File**: None (CLI execution)
**Time**: 2-3 minutes

```bash
# Set TPDB_API_KEY in environment first (required for link-studios)
export TPDB_API_KEY=<your_key>

# Resolve the primary Dredd site (dreddxxx) — expected to return siteId 50864
npm run link-studios -- "https://theporndb.net/sites/dreddxxx" --name "Dredd"

# Resolve the OnlyFans variant
npm run link-studios -- "https://theporndb.net/sites/fansdbdreddxxxonlyfans" --name "Dredd"

# Resolve the ManyVids variant
npm run link-studios -- "https://theporndb.net/sites/manyvidsdredddevastate" --name "Dredd"
```

**Expected output for each**: JSON declaration showing `tpdb.siteId`, `tpdb.name`, `tpdb.shortName`, and `studioId` (format `tpdb-<shortName>` or similar). Verify all three resolve to the same numeric siteId (50864) or note their actual IDs.

### Task 2: Create unified StudioLink declaration
**File**: `.studio-links.json` (new file in repo root, gitignored)
**Time**: 5 minutes

Based on Task 1 results, create a declaration that merges all three TPDB sides under one studioId. If all three resolve to siteId 50864:

```json
[
  {
    "studioId": "tpdb-dredd",
    "studio": "Dredd",
    "aliases": ["Dredd", "dreddxxx", "fansdbdreddxxxonlyfans", "manyvidsdredddevastate"],
    "tpdb": {
      "siteId": 50864,
      "name": "Dredd",
      "shortName": "dreddxxx"
    }
  }
]
```

If the variants resolve to different siteIds, include all three in the `tpdb` object as separate entries (but the spec says they should be unified under 50864).

**Verification**: Run `npm run link-studios -- --write .studio-links.json "https://theporndb.net/sites/dreddxxx" --name "Dredd"` to test the file format, then manually edit to add all three TPDB sites.

### Task 3: Configure LISZT_STUDIO_LINKS
**File**: Environment / deployment config
**Time**: 2 minutes

Set `LISZT_STUDIO_LINKS` to the path of the JSON file (e.g., `.studio-links.json`) or inline JSON. For local testing:

```bash
export LISZT_STUDIO_LINKS=.studio-links.json
npm run dev
```

For production (Render): Add `LISZT_STUDIO_LINKS` as an environment variable pointing to the JSON file in the repo, or add the JSON inline in Render's env vars.

### Task 4: Verify Dredd releases are collected
**File**: None (runtime verification)
**Time**: 2-3 minutes

1. Start the app: `npm run dev` (or wait for deployed sync)
2. Check the dashboard/catalogue for "Dredd" studio
3. Verify releases appear with correct provenance (TPDB, siteId 50864)
4. Confirm no duplicate entries from the three TPDB sources

## Tests / Validation

| Task | Command | Expected Result |
|------|---------|-----------------|
| 1a | `npm run link-studios -- "https://theporndb.net/sites/dreddxxx" --name "Dredd"` | Returns declaration with `tpdb.siteId: 50864` |
| 1b | `npm run link-studios -- "https://theporndb.net/sites/fansdbdreddxxxonlyfans" --name "Dredd"` | Returns declaration (verify siteId) |
| 1c | `npm run link-studios -- "https://theporndb.net/sites/manyvidsdredddevastate" --name "Dredd"` | Returns declaration (verify siteId) |
| 2 | `cat .studio-links.json` | Valid JSON matching StudioLinkSchema |
| 3 | `LISZT_STUDIO_LINKS=.studio-links.json npm run dev` | App starts without config errors |
| 4 | Check dashboard/UI | "Dredd" studio listed with releases from TPDB |

## Risks, Tradeoffs, and Open Questions

1. **TPDB_API_KEY required**: The `link-studios` CLI needs a valid TPDB API key. Must be available in the environment where the command runs.

2. **Site ID verification**: The comment says 50864 is the target, but actual TPDB site IDs for the three URLs must be confirmed. If they differ, the unified declaration must explicitly list all three siteIds (or pick the primary one and accept that the others won't be fetched separately — the TPDB watchlist queries by siteId).

3. **OnlyFans/ManyVids data**: If the OnlyFans and ManyVids TPDB sites have different releases, we need to ensure the unified studio captures all. The TPDB watchlist fetches by `siteId` — if we only declare siteId 50864, only that site's releases are pulled. The solution: declare all three siteIds in the StudioLink (if the schema supports multiple) or accept that only the primary site's releases are fetched.

4. **Schema limitation**: `StudioLink.tpdb` is a single object, not an array. If three different siteIds are needed, we may need to:
   - Pick one primary siteId (50864) and rely on it being comprehensive, OR
   - Create three separate StudioLinks with different studioIds (not unified), OR
   - Extend the schema to support multiple TPDB siteIds per studio (out of scope for this issue).

5. **No code changes**: This issue is solvable entirely through configuration. If Dredd's releases are already covered by another source (e.g., Traxxx, ManyVids adapter), the declaration may be redundant but harmless.

## Completion Criteria
- [ ] Three `link-studios` commands executed and site IDs recorded
- [ ] `.studio-links.json` created with unified Dredd declaration
- [ ] `LISZT_STUDIO_LINKS` configured locally and in production
- [ ] App syncs and Dredd appears in catalogue with releases
- [ ] Issue #116 updated with decision: "Implemented via StudioLink declaration using TPDB siteId 50864"