# Plan: Deduplicate Dredd releases across multiple TPDB siteIds

## Goal
When a studio maps to multiple TPDB siteIds (e.g., Dredd → [50864, 39697, 81939]), ensure the same video appearing on multiple sites produces **one catalogue entry** instead of duplicates.

## Current Context / Assumptions
- **Issue #116**: Dredd has 3 TPDB sites (50864 primary, 39697 OnlyFans, 81939 ManyVids)
- **PR #135** added `siteIds: number[]` support to `TpdbStudio` (pending merge/rebase)
- **Existing dedup**: Issue #129 implemented "store one row per release, not one per lane that saw it" — there's dedup logic at the database/storage layer
- **TPDB scene IDs are per-site**: Same video on dreddxxx and fansdbdreddxxxonlyfans will have different `sourceSceneId` values
- **No cross-site ID mapping**: TPDB doesn't provide a universal content ID across sites

## Architecture / Proposed Approach
The TPDB watchlist will emit scenes from all siteIds for a studio. Duplicates are resolved in two layers:

1. **Emission-time dedup (in watchlist)**: Track emitted `sourceSceneId` per sync; if the same TPDB scene ID appears under multiple siteIds (unlikely but possible), skip subsequent emissions.
2. **Content-based dedup (in sync/storage)**: The existing dedup pipeline (`sync.ts` → `store.ts`) matches by title + date + duration + performers to collapse cross-site duplicates into one catalogue row.

**Key insight**: We don't need perfect cross-site matching in the watchlist. The existing dedup uses title/date/duration/performers fingerprinting which works across sources.

## Step-by-Step Tasks

### Task 1: Update TpdbStudio type to support multiple siteIds
**File**: `src/sources/tpdb-watchlist.ts`
**Time**: 5 min

```typescript
// Line 39-52: Change siteId to siteIds
export interface TpdbStudio {
  studioId: string;
  studio: string;
  aliases: readonly string[];
  tags?: readonly string[];
  /** TPDB site ids this studio maps to. One studio can span multiple TPDB sites. */
  siteIds: number[];
}
```

### Task 2: Update resolution logic to map each siteId to the studio
**File**: `src/sources/tpdb-watchlist.ts`, lines 160-200
**Time**: 10 min

```typescript
// Replace single siteId resolution with multi-siteId
const resolved = new Map<number, TpdbStudio | null>();
for (const studio of options.studios) {
  // Declared siteIds are authoritative
  for (const siteId of studio.siteIds) {
    resolved.set(siteId, studio);
  }
  // Fallback name lookup for undeclared studios (unchanged)
  // ...
}
```

### Task 3: Update fetch loop to iterate over studio.siteIds
**File**: `src/sources/tpdb-watchlist.ts`, lines 202-243
**Time**: 10 min

```typescript
// Replace single siteId loop with per-siteId iteration
const scenes: RawScene[] = [];
const emittedSceneIds = new Set<string>(); // dedup within sync

for (const studio of options.studios) {
  for (const siteId of studio.siteIds) {
    for await (const page of pages(...)) {
      for (const scene of page.data) {
        // Dedup key: TPDB scene ID (per-site)
        const emitKey = `${siteId}:${scene.id}`;
        if (emittedSceneIds.has(emitKey)) continue;
        emittedSceneIds.add(emitKey);

        // ... existing tag filter, scene push logic
        scenes.push({ ... });
      }
    }
  }
}
```

### Task 4: Update StudioLink schema and types for multiple siteIds
**File**: `src/sources/studio-identity.ts`
**Time**: 10 min

```typescript
// Line 477-486: StudioLinkSchema.tpdb
tpdb: z
  .object({
    siteIds: z.array(z.number().int().positive()).min(1),  // was siteId
    uuid: z.string().uuid().optional(),
    name: z.string().min(1),
    shortName: z.string().min(1).optional(),
    url: z.string().url().optional(),
    networkId: z.number().int().positive().optional(),
  })
  .optional(),

// Line 509-516: StudioLink interface
tpdb?: {
  siteIds: number[];  // was siteId
  uuid?: string;
  name: string;
  shortName?: string;
  url?: string;
  networkId?: number;
};
```

### Task 5: Update auditStudioLinks to check siteIds array
**File**: `src/sources/studio-identity.ts`, `auditStudioLinks`
**Time**: 5 min

```typescript
// Replace single siteId check with array iteration
for (const link of links) {
  if (link.tpdb) {
    for (const siteId of link.tpdb.siteIds) {
      bySite.set(siteId, [...(bySite.get(siteId) ?? []), link.studioId]);
    }
  }
  // ...
}
```

### Task 6: Update registry.ts conversion
**File**: `src/sources/registry.ts`
**Time**: 5 min

```typescript
// In createSources, when converting StudioLink[] to TpdbStudio[]
...declared.map((link) => ({
  studioId: link.studioId,
  studio: link.studio,
  aliases: [...],
  ...(link.tags?.length ? { tags: link.tags } : {}),
  // Handle both siteId (legacy) and siteIds (new)
  siteIds: link.tpdb?.siteIds ?? (link.tpdb?.siteId ? [link.tpdb.siteId] : []),
})),
```

### Task 6: Update Dredd's studio links declaration
**File**: `.studio-links.json` (or wherever configured)
**Time**: 2 min

```json
{
  "studioId": "dredd",
  "studio": "Dredd",
  "aliases": ["Dredd", "DreddXXX"],
  "tpdb": {
    "siteIds": [50864, 39697, 81939],
    "name": "DreddXXX",
    "shortName": "dreddxxx"
  }
}
```

### Task 7: Verify dedup works end-to-end
**File**: Test via integration
**Time**: 10 min

```bash
# 1. Typecheck
npm run typecheck

# 2. Format
npm run format:check

# 3. Run tests (if any TPDB-related)
npm test -- --grep "tpdb"

# 4. Manual verification with TPDB_API_KEY
LISZT_STUDIO_LINKS=.studio-links.json TPDB_API_KEY=... npx tsx src/cli/catalogue-coverage.ts 2>&1 | grep -i dredd
```

## Tests / Validation

| Test | Command | Expected |
|------|---------|----------|
| TypeScript compiles | `npm run typecheck` | Exit 0 |
| Format check | `npm run format:check` | Exit 0 |
| Schema validation | `npx tsx -e "import { loadConfig } from './src/config.ts'; console.log(loadConfig().studioLinks)"` | Shows Dredd with siteIds array |
| Unit: auditStudioLinks | Add test case with duplicate siteIds across studios | Throws error |
| Unit: watchlist emits | Mock fetch, verify 3 siteIds queried | 3 requests to different site_ids |
| Integration: Dredd sync | Run with real TPDB_API_KEY | One catalogue entry per unique video |

## Risks, Tradeoffs, and Open Questions

1. **Cross-site duplicate detection**: TPDB scene IDs are per-site. Same video on dreddxxx (id=123) and fansdb (id=456) will emit as two RawScenes. Relies on downstream dedup (title+date+duration+performers) to merge. *Acceptable — existing dedup handles this.*

2. **Performance**: Querying 3 siteIds instead of 1 triples TPDB requests for that studio. *Mitigation: `MIN_INTERVAL_MS=250` pacing already exists; 3 sites = ~750ms extra per sync. Acceptable.*

3. **Tag filtering**: If studio has `tags: ["anal"]`, filter applies per-site. A video tagged "anal" on dreddxxx but not on fansdb would only appear once (from dreddxxx). *Correct behavior.*

4. **Backwards compat**: Existing configs with single `siteId` must work. Handled in Task 6 coercion.

5. **Audit false positives**: `auditStudioLinks` now flags if two studios share ANY siteId. Correct — two studios can't claim the same TPDB site.

6. **Order of siteIds**: First siteId in array is "primary" for display/naming? Not currently used. Could sort by siteId for determinism.

7. **Empty siteIds array**: Schema requires `.min(1)` so at least one required.

## Clarifying Question

**Should we add a dedup key to RawScene to help downstream dedup?**
- Currently: `sourceSceneId = scene.id` (per-site)
- Could add: `dedupKey = `${title}|${date}|${duration}|${performers.join(',')}` 
- Downside: Adds complexity; downstream dedup already computes similar fingerprint.
- **Recommendation**: Don't add — let existing dedup pipeline handle it. Verify in integration test.

---

Ready to implement when you confirm.