# Fix: Add Dredd studio declaration as repo default so it works on VPS without env var

## Problem
The VPS has `TPDB_API_KEY` set but `LISZT_STUDIO_LINKS` is not set, so it defaults to `[]`. Dredd's studio declaration exists only in a local `.studio-links.json` (gitignored), so it doesn't appear on the VPS.

## Solution
Add a fallback in `loadConfig()` to read a committed `studio-links.default.json` from the repo root when `LISZT_STUDIO_LINKS` env var is not set. Commit Dredd's declaration to that file.

## Files to Modify

### 1. `src/config.ts` - Add fallback reader in `loadConfig()`
After parsing `studioLinks` from env (around line 259), add fallback logic:

```typescript
// In loadConfig(), after studioLinks is parsed from env:
const studioLinks = studioLinksFromEnv(env.LISZT_STUDIO_LINKS) ?? readDefaultStudioLinks();

function readDefaultStudioLinks(): unknown {
  try {
    const path = join(__dirname, "..", "studio-links.default.json");
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}
```

You'll need to import `join` from `node:path` and `readFileSync` from `node:fs` at the top of the file.

### 2. Create `studio-links.default.json` in repo root
Commit this file (NOT gitignored):

```json
[
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
]
```

## Verification
1. `npm run typecheck` passes
2. `npm run format:check` passes
3. Test locally: `LISZT_STUDIO_LINKS= TPDB_API_KEY=... npx tsx -e "import { loadConfig } from './src/config.ts'; console.log(JSON.stringify(loadConfig().studioLinks, null, 2))"` — should show Dredd with 3 siteIds
4. Build and deploy — VPS will now pick up Dredd automatically

## Notes
- Operators can still override via `LISZT_STUDIO_LINKS` env var if needed
- The default file is version-controlled, so changes are tracked
- Only Dredd is added for now; other studios can be added similarly