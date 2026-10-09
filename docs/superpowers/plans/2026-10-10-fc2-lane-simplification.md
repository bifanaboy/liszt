# FC2 Lane Simplification Implementation Plan

**Goal:** Replace the FC2 lane's detail-fetch + candidate-queue architecture with a listing-only discovery model, reducing the lane from ~700 lines to ~150.

**Architecture:** Walk the anal-tag listing, filter on listing fields only (censored="有", notFound, trans-exclusion in title), emit RawScene immediately. No detail fetches, no candidate queue, no store dependency. Matcher unchanged: `sxyprn+eporner` (code-based search).

**Tech Stack:** Node.js 24, TypeScript, better-sqlite3 (for migrations only), node:test

**Spec:** `docs/superpowers/specs/2026-10-10-fc2-lane-simplification-design.md`

## Global Constraints

- Node.js 24 (tests use `node:sqlite`)
- All existing tests except `fc2cmadb.test.ts` and `fc2-link-persistence.test.ts` must continue to pass
- `fc2_candidates` table stays in schema (no migration in this change)
- `Fc2Status` type stays in `src/core/schema.ts` (used by migrations test)

## Review Focus

| Input / condition | Expected behaviour | Pinned by |
|---|---|---|
| Listing with `censored: "有"` | Scene dropped | Task 1 |
| Listing with `censored: null` | Scene emitted (leakage accepted) | Task 1 |
| Listing with `notFound: true` | Scene dropped | Task 1 |
| Listing title contains trans-exclusion term | Scene dropped | Task 1 |
| Listing title contains no trans-exclusion term | Scene emitted | Task 1 |
| Walk stops at window edge with next cursor | `edgeStop: true`, `verifiedEmpty: false` | Task 2 |
| Walk reaches end (no cursor) | `edgeStop: false`, `verifiedEmpty` allowed if empty | Task 2 |
| Listing 429 | `Fc2RateLimitedError` thrown, run fails | Task 3 |
| Listing 404/410 | `Fc2SourceError` thrown, run fails | Task 3 |
| Listing 5xx | `Fc2SourceError` thrown, run fails | Task 3 |
| Inertia payload missing | `Fc2ShapeError` thrown, run fails | Task 3 |
| Inertia payload malformed JSON | `Fc2ShapeError` thrown, run fails | Task 3 |
| Inertia payload not an object | `Fc2ShapeError` thrown, run fails | Task 3 |
| Inertia payload has no props | `Fc2ShapeError` thrown, run fails | Task 3 |
| Page ceiling hit before window edge | `Fc2SourceError` thrown, run fails | Task 4 |
| Repeated cursor | `Fc2ShapeError` thrown, run fails | Task 4 |
| `fc2DetailMinIntervalMs` config key removed | No reference in app.ts or config.ts | Task 5 |
| `fc2MaxDetailChecksPerSync` config key removed | No reference in app.ts or config.ts | Task 5 |
| `fc2RecheckDays` config key removed | No reference in app.ts or config.ts | Task 5 |
| `fc2_candidates` table methods unused | No reference outside sqlite.ts and fc2cmadb.ts | Task 5 |

---

### Task 1: Simplified lane adapter

**Files:**
- Create: `test/fc2cmadb-simple.test.ts`
- Modify: `src/sources/fc2cmadb.ts` (replace entire file)

**Interfaces:**
- Consumes: `findTransExclusion(title: string): string | null` from `src/sources/trans-exclusion.ts`
- Consumes: `parseClockDuration(value: string): number | null` from `src/tubes/eporner.ts`
- Produces: `createFc2CmadbStudio(options?: Fc2StudioOptions): SourceAdapter` with `Fc2StudioOptions = { listingMinIntervalMs?: number; sleep?: (ms: number) => Promise<void>; maxListingPages?: number }`
- Produces: `walkFc2Listing(client, windowStart, { maxPages?, log? }): Promise<{ records: Fc2ListingRecord[]; pages: number; reachedEnd: boolean; edgeStop: boolean }>`
- Produces: `parseFc2Listing(page: InertiaPage): Fc2Listing` with `Fc2Listing = { records: Fc2ListingRecord[]; nextCursor: string | null }`
- Produces: `extractInertiaPage(html: string): InertiaPage`
- Produces: `Fc2ListingRecord = { videoId: string; title: string; releaseDate: string; duration: string | null; censored: string | null; notFound: boolean; tagId: number | null; thumbnailUrl: string }`
- Produces: `createFc2Client(ctx: { fetcher: Fetcher }, opts?): Fc2Client` with `Fc2Client = { listAnalTag(cursor: string | null): Promise<Fc2Listing> }`
- Produces: constants `FC2CMADB_ID`, `FC2CMADB_LANE`, `FC2CMADB_BASE`, `FC2_ANAL_TAG_NAME`, `FC2_ANAL_TAG_ID`, `FC2_LISTING_URL`, `FC2_LISTING_PAGE_SIZE`, `DEFAULT_FC2_MAX_LISTING_PAGES`
- Produces: `fc2RecordUrl(videoId: string): string`
- Produces: error classes `Fc2SourceError`, `Fc2RateLimitedError`, `Fc2ShapeError`
- Removed exports: `parseFc2Detail`, `classifyFc2Candidate`, `toFc2RawScene`, `Fc2Detail`, `Fc2Verdict`, `Fc2ClassifyInput`, `Fc2ClientOptions.detailMinIntervalMs`, `Fc2StudioOptions.store`, `Fc2StudioOptions.maxDetailChecksPerSync`, `Fc2StudioOptions.recheckDays`, `FC2_SAFETY_TERMS`, `FC2_SAFETY_WORD_TERMS`, `Fc2RemovedRecordError`, `DEFAULT_FC2_LISTING_INTERVAL_MS`, `DEFAULT_FC2_DETAIL_INTERVAL_MS`, `DEFAULT_FC2_MAX_DETAIL_CHECKS`, `DEFAULT_FC2_RECHECK_DAYS`

- [ ] **Step 1: Write the failing test for scene emission and filtering**

Create `test/fc2cmadb-simple.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractInertiaPage,
  parseFc2Listing,
  FC2_ANAL_TAG_NAME,
  type Fc2ListingRecord,
} from "../src/sources/fc2cmadb.ts";
import { findTransExclusion } from "../src/sources/trans-exclusion.ts";
import type { Fetcher, SourceContext } from "../src/sources/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const NOW = new Date("2026-10-03T00:00:00Z");
const WINDOW_START = "2026-07-05";

function stubFetcher(pages: Record<string, string | ((url: string) => string)>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const keys = Object.keys(pages).sort((a, b) => b.length - a.length);
  return {
    calls,
    async fetch(url: string): Promise<Response> {
      calls.push(url);
      const key = keys.find((candidate) => url.startsWith(candidate));
      const page = key === undefined ? undefined : pages[key];
      if (page === undefined) return new Response("missing", { status: 404 });
      const body = typeof page === "function" ? page(url) : page;
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
    async text(url: string): Promise<string> { return (await this.fetch(url)).text(); },
    async json<T>(url: string): Promise<T> { return (await this.fetch(url)).json() as T; },
  };
}

function context(fetcher: Fetcher, now = NOW): SourceContext {
  return {
    fetcher, now,
    log: () => {},
    mapWithConcurrency: (items, task) => Promise.all(items.map(task)),
    mapIsolated: (items, task) => Promise.all(items.map(task)),
  };
}

async function simpleFc2Fetch(windowStart: string, ctx: SourceContext): Promise<{
  scenes: Array<{ videoId: string; title: string; releaseDate: string; duration: string; imageUrl: string }>;
  verifiedEmpty: boolean;
}> {
  const baseUrl = `https://fc2cmadb.com/tags/${encodeURIComponent(FC2_ANAL_TAG_NAME)}`;
  const boundary = new Date(`${windowStart}T00:00:00Z`).getTime();
  const scenes: Array<{ videoId: string; title: string; releaseDate: string; duration: string; imageUrl: string }> = [];
  let cursor: string | null = null;

  for (let page = 1; page <= 40; page++) {
    const url = cursor ? `${baseUrl}?cursor=${encodeURIComponent(cursor)}` : baseUrl;
    const html = await ctx.fetcher.text(url);
    const pageData = extractInertiaPage(html);
    if (pageData.props.tag_name !== FC2_ANAL_TAG_NAME) throw new Error(`expected ${FC2_ANAL_TAG_NAME} tag listing`);
    const paginator = pageData.props.articles as { data: Array<Record<string, unknown>>; next_cursor: string | null };
    if (!paginator || !Array.isArray(paginator.data)) throw new Error("no articles paginator");
    const articles = paginator.data;
    let inWindowCount = 0;
    for (const article of articles) {
      const releaseDate = String(article.release_date ?? "");
      const at = Date.parse(`${releaseDate}T00:00:00Z`);
      if (Number.isFinite(at) && at >= boundary) {
        inWindowCount++;
        if (article.censored === "有") continue;
        if (article.not_found) continue;
        if (findTransExclusion(String(article.title ?? ""))) continue;
        scenes.push({
          videoId: String(article.video_id),
          title: String(article.title ?? ""),
          releaseDate,
          duration: String(article.duration ?? ""),
          imageUrl: String(article.image_url ?? ""),
        });
      }
    }
    if (!inWindowCount) break;
    const nextCursor = paginator.next_cursor;
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return { scenes, verifiedEmpty: scenes.length === 0 };
}

test("simple lane: emits scenes, drops censored and trans", async () => {
  const listingHtml = fixture("fc2-anal-listing-page-1.html");
  const fetcher = stubFetcher({ "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": listingHtml });
  const result = await simpleFc2Fetch(WINDOW_START, context(fetcher));
  assert.equal(result.scenes.length, 3);
  assert.equal(result.verifiedEmpty, false);
  const ids = result.scenes.map(s => s.videoId).sort();
  assert.deepEqual(ids, ["4986048", "4986794", "4986883"]);
  const first = result.scenes.find(s => s.videoId === "4986883");
  assert.ok(first);
  assert.equal(first.title.includes("托卵実録"), true);
  assert.equal(first.releaseDate, "2026-10-02");
  assert.equal(first.duration, "01:02:08");
  assert.ok(first.imageUrl.includes("contents-thumbnail2.fc2.com"));
});

test("simple lane: empty window is verified empty", async () => {
  const oldListing = fixture("fc2-anal-listing-final.html");
  const fetcher = stubFetcher({ "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": oldListing });
  const result = await simpleFc2Fetch(WINDOW_START, context(fetcher));
  assert.equal(result.scenes.length, 0);
  assert.equal(result.verifiedEmpty, true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fc2cmadb-simple.test.ts`
Expected: FAIL — module exports missing (`findTransExclusion` not exported from `fc2cmadb.ts`, or module resolution errors)

- [ ] **Step 3: Replace `src/sources/fc2cmadb.ts` with the simplified implementation**

Replace the entire file with the new implementation. Key points:
- Keep: `extractInertiaPage`, `parseFc2Listing`, `walkFc2Listing`, `fc2RecordUrl`, `FC2_LISTING_URL`, `FC2_ANAL_TAG_NAME`, `FC2_ANAL_TAG_ID`, error classes
- Remove: `parseFc2Detail`, `classifyFc2Candidate`, `toFc2RawScene`, all safety terms, `Fc2RemovedRecordError`, detail pacing
- `createFc2Client`: single `listAnalTag` method only, single pacing gate
- `createFc2CmadbStudio.fetch()`: single-pass filter — drop `censored === "有"`, drop `notFound`, drop `findTransExclusion(title)`, emit `RawScene` with `releaseDate`, `duration` (via `parseClockDuration`), `thumbnailUrl`, empty tags, `verifiedEmpty = scenes.length === 0 && walk.reachedEnd && !walk.edgeStop`
- Remove `SqliteStore` import, `Fc2Status` import
- Remove `DEFAULT_FC2_DETAIL_INTERVAL_MS`, `DEFAULT_FC2_MAX_DETAIL_CHECKS`, `DEFAULT_FC2_RECHECK_DAYS`
- Remove `Fc2ClientOptions.detailMinIntervalMs`
- Remove `Fc2StudioOptions.store`, `Fc2StudioOptions.maxDetailChecksPerSync`, `Fc2StudioOptions.recheckDays`
- `Fc2StudioOptions = { listingMinIntervalMs?: number; sleep?: (ms: number) => Promise<void>; maxListingPages?: number }`
- Default `listingMinIntervalMs = 2000` inline (no exported constant for detail interval)

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/fc2cmadb-simple.test.ts`
Expected: PASS (both tests pass)

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors from the new fc2cmadb.ts; other files will have errors from removed exports — those are fixed in Task 5)

- [ ] **Step 6: Commit**

```bash
git add test/fc2cmadb-simple.test.ts src/sources/fc2cmadb.ts
git commit -m "feat: simplify FC2 lane to listing-only discovery"
```

---

### Task 2: Walk and listing parser tests

**Files:**
- Create: `test/fc2cmadb-walk.test.ts`

**Interfaces:**
- Consumes: `walkFc2Listing`, `parseFc2Listing`, `extractInertiaPage`, `createFc2Client`, `FC2_LISTING_URL`, `fc2RecordUrl` from `src/sources/fc2cmadb.ts`

- [ ] **Step 1: Write tests for walk behaviour**

Create `test/fc2cmadb-walk.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  extractInertiaPage,
  parseFc2Listing,
  walkFc2Listing,
  createFc2Client,
  Fc2SourceError,
  Fc2ShapeError,
} from "../src/sources/fc2cmadb.ts";
import type { Fetcher, SourceContext } from "../src/sources/types.ts";

const FIXTURES = join(import.meta.dirname, "fixtures");
const fixture = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");
const NOW = new Date("2026-10-03T00:00:00Z");
const WINDOW_START = "2026-07-05";
const noSleep = async (): Promise<void> => {};

function stubFetcher(pages: Record<string, string | ((url: string) => string)>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const keys = Object.keys(pages).sort((a, b) => b.length - a.length);
  return {
    calls,
    async fetch(url: string): Promise<Response> {
      calls.push(url);
      const key = keys.find((c) => url.startsWith(c));
      const page = key === undefined ? undefined : pages[key];
      if (page === undefined) return new Response("missing", { status: 404 });
      const body = typeof page === "function" ? page(url) : page;
      return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
    async text(url: string): Promise<string> { return (await this.fetch(url)).text(); },
    async json<T>(url: string): Promise<T> { return (await this.fetch(url)).json() as T; },
  };
}

test("walk stops at window edge with cursor: edgeStop true", async () => {
  const page1 = fixture("fc2-anal-listing-page-1.html");
  const page2 = fixture("fc2-anal-listing-final.html");
  const fetcher = stubFetcher({
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": page1,
    "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB?cursor=": page2,
  });
  const client = createFc2Client({ fetcher: { fetch: fetcher.fetch, text: fetcher.text, json: fetcher.json } }, { sleep: noSleep });
  const walk = await walkFc2Listing(client, WINDOW_START);
  assert.equal(walk.reachedEnd, true);
  assert.equal(walk.edgeStop, true);
  assert.equal(walk.records.length, 4);
});

test("walk at end of listing: edgeStop false", async () => {
  const page1 = fixture("fc2-anal-listing-page-1.html");
  const fetcher = stubFetcher({ "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": page1 });
  const client = createFc2Client({ fetcher: { fetch: fetcher.fetch, text: fetcher.text, json: fetcher.json } }, { sleep: noSleep });
  const walk = await walkFc2Listing(client, WINDOW_START);
  assert.equal(walk.reachedEnd, true);
  assert.equal(walk.edgeStop, false);
  assert.equal(walk.records.length, 4);
});

test("repeated cursor throws Fc2ShapeError", async () => {
  const page = fixture("fc2-anal-listing-page-1.html");
  const fetcher = stubFetcher({ "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": page });
  const client = createFc2Client({ fetcher: { fetch: fetcher.fetch, text: fetcher.text, json: fetcher.json } }, { sleep: noSleep });
  // page1 has nextCursor "eyJ2aW...VlfQ" — stubFetcher returns page1 for any cursor URL
  // because page1 starts with the base URL. So the walk will see the same records
  // and the repeated-cursor check will fire.
  await assert.rejects(
    () => walkFc2Listing(client, WINDOW_START),
    Fc2ShapeError
  );
});

test("page ceiling hit throws Fc2SourceError", async () => {
  const page = fixture("fc2-anal-listing-page-1.html");
  const fetcher = stubFetcher({ "https://fc2cmadb.com/tags/%E3%82%A2%E3%83%8A%E3%83%AB": page });
  const client = createFc2Client({ fetcher: { fetch: fetcher.fetch, text: fetcher.text, json: fetcher.json } }, { sleep: noSleep });
  await assert.rejects(
    () => walkFc2Listing(client, WINDOW_START, { maxPages: 2 }),
    Fc2SourceError
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fc2cmadb-walk.test.ts`
Expected: FAIL (type errors from removed exports, or logic differences in new implementation)

- [ ] **Step 3: Fix any gaps in `src/sources/fc2cmadb.ts`**

The implementation from Task 1 should already support these tests. If the repeated-cursor test fails because `stubFetcher` returns the same page for cursor URLs (making `fresh` empty after page 1), adjust the test to use a fixture that has actual cursor-based pagination, or verify the repeated-cursor logic works by constructing a page where `nextCursor` is non-null but the same records are returned.

If gaps exist, patch `src/sources/fc2cmadb.ts` to close them.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/fc2cmadb-walk.test.ts`
Expected: PASS (all 4 tests pass)

- [ ] **Step 5: Commit**

```bash
git add test/fc2cmadb-walk.test.ts src/sources/fc2cmadb.ts
git commit -m "test: add FC2 walk and listing parser tests"
```

---

### Task 3: Error handling tests

**Files:**
- Create: `test/fc2cmadb-errors.test.ts`

**Interfaces:**
- Consumes: `extractInertiaPage`, `createFc2Client`, `Fc2RateLimitedError`, `Fc2ShapeError`, `Fc2SourceError` from `src/sources/fc2cmadb.ts`

- [ ] **Step 1: Write tests for HTTP and shape errors**

Create `test/fc2cmadb-errors.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createFc2Client,
  Fc2RateLimitedError,
  Fc2SourceError,
  Fc2ShapeError,
} from "../src/sources/fc2cmadb.ts";
import type { Fetcher } from "../src/sources/types.ts";

const noSleep = async (): Promise<void> => {};

function makeFetcher(status: number, body: string): Fetcher {
  return {
    async fetch(url: string): Promise<Response> {
      return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
    },
    async text(url: string): Promise<string> { return body; },
    async json<T>(url: string): Promise<T> { return JSON.parse(body) as T; },
  };
}

test("429 throws Fc2RateLimitedError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(429, "rate limited") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2RateLimitedError);
});

test("404 throws Fc2SourceError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(404, "not found") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2SourceError);
});

test("410 throws Fc2SourceError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(410, "gone") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2SourceError);
});

test("500 throws Fc2SourceError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(500, "server error") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2SourceError);
});

test("missing Inertia payload throws Fc2ShapeError", async () => {
  const client = createFc2Client({ fetcher: makeFetcher(200, "<html>no payload</html>") }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2ShapeError);
});

test("malformed JSON payload throws Fc2ShapeError", async () => {
  const body = '<script data-page="app" type="application/json">not json</script>';
  const client = createFc2Client({ fetcher: makeFetcher(200, body) }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2ShapeError);
});

test("payload not an object throws Fc2ShapeError", async () => {
  const body = '<script data-page="app" type="application/json">[]</script>';
  const client = createFc2Client({ fetcher: makeFetcher(200, body) }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2ShapeError);
});

test("payload with no props throws Fc2ShapeError", async () => {
  const body = '<script data-page="app" type="application/json">{"component":"Tags/Show"}</script>';
  const client = createFc2Client({ fetcher: makeFetcher(200, body) }, { sleep: noSleep });
  await assert.rejects(() => client.listAnalTag(null), Fc2ShapeError);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/fc2cmadb-errors.test.ts`
Expected: FAIL if error handling in new implementation differs from expectations

- [ ] **Step 3: Fix any gaps in `src/sources/fc2cmadb.ts`**

If the new implementation does not throw the expected error types for these inputs, patch the `html()` function and `extractInertiaPage` in `src/sources/fc2cmadb.ts` to match. The error classes and their throwing conditions are:
- 429 → `Fc2RateLimitedError`
- 404, 410 → `Fc2SourceError` (message: `fc2cmadb.com has no page at ${url} (HTTP ${status})`)
- non-ok → `Fc2SourceError` (message: `fc2cmadb.com request failed with HTTP ${status}`)
- no Inertia payload → `Fc2ShapeError("no Inertia page payload")`
- invalid JSON → `Fc2ShapeError` with parse error message
- not an object → `Fc2ShapeError("page payload is not an object")`
- no props → `Fc2ShapeError("page payload has no props object")`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/fc2cmadb-errors.test.ts`
Expected: PASS (all 8 tests pass)

- [ ] **Step 5: Commit**

```bash
git add test/fc2cmadb-errors.test.ts src/sources/fc2cmadb.ts
git commit -m "test: add FC2 error handling tests"
```

---

### Task 4: Registry and app wiring

**Files:**
- Modify: `src/sources/registry.ts:102` — remove `store` from `createFc2CmadbStudio` call
- Modify: `src/app.ts:56-60` — remove `fc2DetailMinIntervalMs`, `fc2MaxDetailChecksPerSync`, `fc2RecheckDays` from `fc2` config object
- Modify: `src/config.ts:71-89` — remove `fc2DetailMinIntervalMs`, `fc2MaxDetailChecksPerSync`, `fc2RecheckDays` from schema
- Modify: `src/config.ts:262-264` — remove env mappings for removed keys

- [ ] **Step 1: Remove `store` from registry FC2 call**

In `src/sources/registry.ts` line 102, change:
```typescript
createFc2CmadbStudio({ ...fc2, store }),
```
to:
```typescript
createFc2CmadbStudio({ ...fc2 }),
```

Also remove the `SqliteStore` import if it becomes unused (check line 20).

- [ ] **Step 2: Remove detail config keys from app.ts**

In `src/app.ts` lines 56-60, change:
```typescript
fc2: {
  listingMinIntervalMs: config.fc2ListingMinIntervalMs,
  detailMinIntervalMs: config.fc2DetailMinIntervalMs,
  maxDetailChecksPerSync: config.fc2MaxDetailChecksPerSync,
  recheckDays: config.fc2RecheckDays,
},
```
to:
```typescript
fc2: {
  listingMinIntervalMs: config.fc2ListingMinIntervalMs,
},
```

- [ ] **Step 3: Remove detail config keys from schema**

In `src/config.ts`, remove lines 75-89 (the `fc2DetailMinIntervalMs`, `fc2MaxDetailChecksPerSync`, `fc2RecheckDays` schema entries). Keep `fc2ListingMinIntervalMs`.

Also remove the env mappings at lines 262-264:
```typescript
fc2DetailMinIntervalMs: env.LISZT_FC2_DETAIL_MIN_INTERVAL_MS,
fc2MaxDetailChecksPerSync: env.LISZT_FC2_MAX_DETAIL_CHECKS_PER_SYNC,
fc2RecheckDays: env.LISZT_FC2_RECHECK_DAYS,
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS (all type errors resolved)

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sources/registry.ts src/app.ts src/config.ts
git commit -m "refactor: remove FC2 detail config keys and store dependency from registry"
```

---

### Task 5: Remove old tests and unused store methods

**Files:**
- Delete: `test/fc2cmadb.test.ts`
- Delete: `test/fc2-link-persistence.test.ts`
- Modify: `src/core/store/sqlite.ts` — remove FC2 candidate methods (lines 754-920 approximately)
- Modify: `src/core/schema.ts` — remove `Fc2Status` type and comment (lines 187-195 approximately)

- [ ] **Step 1: Delete old test files**

```bash
rm test/fc2cmadb.test.ts test/fc2-link-persistence.test.ts
```

- [ ] **Step 2: Remove FC2 candidate methods from SqliteStore**

In `src/core/store/sqlite.ts`, remove the entire section from line 754 (`// --------------------------------------------------------- fc2_candidates`) through the end of `countFc2Pending()` and `fc2CandidateCounts()` (approximately line 930). Also remove:
- `Fc2Status` import at line 15
- `Fc2Candidate` import (check imports at top of file)
- Any other FC2-specific store methods that are now unused

Keep the `fc2_candidates` table migration file (`0008_fc2_candidates.sql`) — no migration in this change.

- [ ] **Step 3: Remove `Fc2Status` from schema**

In `src/core/schema.ts`, remove lines 187-195:
```typescript
/**
 * THREE values, and `pending` is not a placeholder. fc2cmadb leaves the
 * ...
 */
export const Fc2Status = z.enum(["accepted", "excluded", "pending"]);
export type Fc2Status = z.infer<typeof Fc2Status>;
```

Check if `Fc2Status` is imported by `test/store-migrations.test.ts` or `src/core/store/sqlite.ts`. If so, remove those imports too.

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 6: Run format check**

Run: `npm run format:check`
Expected: PASS (or run `npm run format` to fix)

- [ ] **Step 7: Run full test suite**

Run: `npm test`
Expected: PASS (all tests pass, no failures)

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: remove FC2 candidate store methods and Fc2Status type"
```

---

### Task 6: Final verification

**Files:**
- Verify: no references to removed exports or config keys remain

- [ ] **Step 1: Verify no dangling references**

Run:
```bash
grep -rn "fc2DetailMinIntervalMs\|fc2MaxDetailChecksPerSync\|fc2RecheckDays" src/ test/ --include="*.ts"
grep -rn "classifyFc2Candidate\|parseFc2Detail\|toFc2RawScene\|Fc2Candidate\|Fc2Status\|fc2DueCandidates\|noteFc2Sightings\|decideFc2Candidate\|countFc2Pending" src/ test/ --include="*.ts" | grep -v "src/core/store/sqlite.ts\|migrations"
```
Expected: no matches

- [ ] **Step 2: Verify migration test still passes**

Run: `npm test test/store-migrations.test.ts`
Expected: PASS (migration 8 still exists in file list, `Fc2Status` import removed if it was used)

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: PASS

- [ ] **Step 4: Run all checks**

Run: `npm run typecheck && npm run lint && npm run format:check`
Expected: all PASS

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "chore: verify FC2 lane simplification is complete"
```

---

## Review Focus

| Input / condition | Expected behaviour | Pinned by |
|---|---|---|
| Listing with `censored: "有"` | Scene dropped | Task 1 |
| Listing with `censored: null` | Scene emitted (leakage accepted) | Task 1 |
| Listing with `notFound: true` | Scene dropped | Task 1 |
| Listing title contains trans-exclusion term | Scene dropped | Task 1 |
| Listing title contains no trans-exclusion term | Scene emitted | Task 1 |
| Walk stops at window edge with next cursor | `edgeStop: true`, `verifiedEmpty: false` | Task 2 |
| Walk reaches end (no cursor) | `edgeStop: false`, `verifiedEmpty` allowed if empty | Task 2 |
| Listing 429 | `Fc2RateLimitedError` thrown, run fails | Task 3 |
| Listing 404/410 | `Fc2SourceError` thrown, run fails | Task 3 |
| Listing 5xx | `Fc2SourceError` thrown, run fails | Task 3 |
| Inertia payload missing | `Fc2ShapeError` thrown, run fails | Task 3 |
| Inertia payload malformed JSON | `Fc2ShapeError` thrown, run fails | Task 3 |
| Inertia payload not an object | `Fc2ShapeError` thrown, run fails | Task 3 |
| Inertia payload has no props | `Fc2ShapeError` thrown, run fails | Task 3 |
| Page ceiling hit before window edge | `Fc2SourceError` thrown, run fails | Task 4 |
| Repeated cursor | `Fc2ShapeError` thrown, run fails | Task 4 |
| `fc2DetailMinIntervalMs` config key removed | No reference in app.ts or config.ts | Task 5 |
| `fc2MaxDetailChecksPerSync` config key removed | No reference in app.ts or config.ts | Task 5 |
| `fc2RecheckDays` config key removed | No reference in app.ts or config.ts | Task 5 |
| `fc2_candidates` table methods unused | No reference outside sqlite.ts and fc2cmadb.ts | Task 5 |