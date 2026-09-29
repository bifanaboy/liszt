# Liszt

Liszt is a rolling release catalogue and playback-link resolver. The public
Liszt implementations are:

- [`liszt-codex`](https://github.com/bifanaboy/liszt-codex), the original
  JSON-catalogue application; and
- [`liszt-hands`](https://github.com/bifanaboy/liszt-hands), the newer
  SQLite-backed service.

This repository is the documentation home for both applications. The two
public repositories were inspected before writing this document. They are
parallel implementations: no source file in either repository imports the
other, and no runtime API or shared database between them is defined. The
descriptions below therefore distinguish their behavior instead of presenting
them as one deployed system.

The source snapshot reviewed for this document was `liszt-codex` commit
[`77c9dafe`](https://github.com/bifanaboy/liszt-codex/commit/77c9dafe7cf23a0d7af85c039812a477842508ce)
and `liszt-hands` commit
[`12cd7df2`](https://github.com/bifanaboy/liszt-hands/commit/12cd7df2bcea2da8312cf63a4dc0cd5692b5c102).
The `main` links below are convenient navigation links; behavior can change as
those public repositories evolve.

## What each application does

Both applications maintain a configurable, normally 90-day watchlist of
studio releases. A catalogue adapter obtains scene metadata, normalises it to
a stable record, and (for lanes with a matcher) searches tube/video sources for
playback pages. A link is stored only when the measured identity gate accepts
it. The central safety rule is: **a missing link is preferable to a wrong
link**.

The applications display titles, release dates, performers, duration when
available, thumbnails, source/release pages, studio labels, playback links,
source health, and refresh/run information. They do not claim complete tube
coverage: an unmatched scene is a valid result.

### Liszt-codex

Codex is a Node.js web app whose durable catalogue is JSON. Its normal runtime
serves the committed snapshot and does not refresh sources from the public
HTTP endpoint. Refresh is a separate one-shot operation, normally run by the
manual GitHub Actions workflow, which commits the generated catalogue and
translation cache; Render then deploys the resulting `main` snapshot.

Relevant components:

- `src/sync.js` orchestrates source reads, rolling-window filtering,
  translation carry-forward, link enrichment, and JSON writes.
- `src/studios/index.js` registers the six lanes: Lancelot Styles Evolution,
  Mambo Perv, Tushy, Bang! Originals, Maximo Garcia, and the mainland/Taiwan
  Madouqu lane.
- `src/studios/tpdb.js` reads ThePornDB (TPDB) for the TPDB-backed studios.
- `src/studios/bang-originals.js` reads Bang! Originals listing and video
  pages.
- `src/studios/madouqu.js` reads Madouqu posts through the public WordPress.com
  API and applies the metadata-only content filter.
- `src/sxyprn.js`, `src/eporner.js`, and `src/matching.js` perform playback
  discovery and matching.
- `src/reverify.js` rotates link verification and moves repeatedly dead links
  into history.
- `src/server.js` serves `/api/scenes`, the static dashboard, and the playback
  proxy. `/api/refresh` intentionally returns `410`; it tells operators to
  refresh the durable catalogue through GitHub Actions.
- `data/catalogue.json` and `data/translations.json` are the bundled seed
  snapshots. Runtime paths can be changed with `LISZT_DATA_PATH`,
  `LISZT_TRANSLATIONS_PATH`, or `LISZT_DATA_DIR`.

Codex's dashboard supports free-text search over titles, performers, and
studios; studio filters; newest, oldest, and title sorting; source-health and
catalogue totals; CSV export; and playback/source-page links.

### Liszt-hands

Hands is the newer service. It uses native Node 24 TypeScript execution and
stores scenes, live/dead links, studios, runs, and translations in SQLite on a
persistent disk. The server and the one-shot CLI use the same sync path:

- `src/app.ts` composes the HTTP server, store, adapters, matchers, and
  background translation pass. `POST /api/refresh` starts one refresh and
  coalesces concurrent requests with the in-flight refresh.
- `src/cli/sync.ts` runs one cycle and writes one JSON result to stdout; JSON
  logs go to stderr for CLI use.
- `src/sync.ts` isolates source failures, retains still-in-window last-good
  scenes for a failed source, removes scenes outside the rolling window, then
  resolves links and records a run.
- `src/core/schema/index.ts` is the single Zod parse boundary. It enforces
  date-only release dates, stable scene identity, URL-shaped links, provenance,
  and the metadata-only matcher marker.
- `src/core/store/migrations/0001_init.sql` defines the SQLite tables and
  indexes. `src/core/store/sqlite.ts` applies migrations transactionally and
  upserts scenes by primary key.
- `src/serving/read-model.ts` supplies the dashboard's scene, studio-status,
  and recent-run view.

Hands exposes `/api/health`, `/api/scenes`, `/api/studios`, `/api/runs`, and
`POST /api/refresh`, plus the static dashboard. Its Docker and Render
configuration mounts the SQLite database under `/data` on a persistent disk.

## End-to-end lifecycle

The following is the common conceptual lifecycle. The source and persistence
details differ as described in the application sections below.

```text
configured source
      |
      v
recent raw scene records -> source-specific filters/enrichment
      |
      v
canonical scene id + date-only metadata + provenance
      |
      +--> optional title/studio-label translation
      |
      +--> query candidate tubes -> duration/identity gate -> verified links
      |
      v
stored scene + source health + run history -> dashboard/API
```

### 1. Select the rolling window

The default window is 90 days. The lower bound is calculated from the current
time, and only records whose release date is no later than `now` and no earlier
than the lower bound are retained for the active view. Hands validates release
dates as real `YYYY-MM-DD` values at the schema boundary; Codex applies the
same date-only window arithmetic but its older JSON schema is less strict.

The window is a display and retention boundary, not a promise that a source
will return every historical record. Tube links are attempted only for eligible
lanes and scenes with a usable positive duration.

### 2. Source metadata

#### Hands source lanes

The current `src/catalogue/registry.ts` registers:

| Lane | Source and behavior | Matcher |
| --- | --- | --- |
| Lancelot Styles Evolution | `traxxx.me` channel `lancelotstyles` | `sxyprn+eporner` |
| Mambo Perv | `traxxx.me` channel `mamboperv` | `sxyprn+eporner` |
| Tushy | `traxxx.me` channel `tushy` | `sxyprn+eporner` |
| Maximo Garcia | TPDB site id `7875`; female-performer requirement; creator-studio flag | `sxyprn+eporner` |
| Bang! Originals | Bang listing and per-video pages | `sxyprn+eporner` |
| Madouqu mainland/Taiwan lane | Madouqu WordPress posts and categories | none |

The traxxx adapter (`src/catalogue/traxxx.ts`) calls `GET /api/scenes` with a
channel/network entity filter, walks newest-first pages, and stops once records
are older than the window. It reads scene id, title, date, duration, actors,
tags, poster, and the studio release URL. Dates are reduced to the date part;
performer extraction drops male actors to match the project's tube-query
convention; poster paths are rebuilt against `cdn.traxxx.me`. `traxxx.me` is a
query source only: Hands does not fork, self-host, authenticate to, or use its
internal `/graphql` endpoint.

The traxxx client has a load-bearing filter guard. It compares the filtered
total with an unfiltered total because an unknown entity can otherwise be
silently ignored and return the whole index. Equal totals cause the source run
to fail; records are also checked against the requested entity. Requests are
paced (`LISZT_TRAXXX_MIN_INTERVAL_MS`, default 250 ms), cached during a run
(`LISZT_TRAXXX_CACHE_TTL_MS`, default five minutes), and retried with bounded
backoff for rate-limit/network failures.

The TPDB adapter (`src/catalogue/tpdb.ts`) uses `TPDB_API_KEY`, requests pages
of 100, and filters by site and date. It accepts several possible TPDB id,
duration, poster, and performer field shapes. It removes duplicate performer
names and excludes performers identified as male; Maximo additionally requires
at least one female performer. Missing duration, release date, or performers
triggers a best-effort scrape of the scene's own release URL.

The studio-site scraper (`src/catalogue/studio-site.ts`) is allowlisted to
`sexlikereal.com` and `analvids.com`, rejects private/reserved hosts, and
revalidates redirects. It reads JSON-LD/meta data first and host-specific
recipes second. It can fill duration, release date, and performer fields and
records `studio-site` field provenance. A bad, dead, unsupported, or
unparseable page leaves the scene metadata-poor; it does not invent values.

The Bang adapter (`src/catalogue/bang-originals.ts`) scrapes the Bang! listing,
follows recent pagination, then reads each page's JSON-LD `VideoObject` for
title, date, actors, and thumbnail. It spaces requests and retries transient,
429, and 5xx failures. Missing required page metadata fails the lane rather
than emitting a partial scene.

The Madouqu adapter (`src/catalogue/madouqu.ts`) queries the WordPress REST
API using several configured search terms, deduplicates posts by WordPress id,
maps category ids to separate studio labels, and re-checks the title because
WordPress search also matches post content. It admits only titles classified as
anal sex by the ordered safety/content rules, excludes safety, trans/gay,
non-anal, and play-only terms, and stores title evidence through logs and
provenance. It sets `matcher: null`, so its scenes are catalogue metadata only
and never enter tube matching.

#### Codex source lanes

Codex's `src/studios/index.js` registers the same broad set, but at the
inspected public revision Lancelot Styles Evolution, Mambo Perv, Tushy, and
Maximo are TPDB-backed rather than traxxx-backed. Bang uses the studio scraper;
Madouqu uses the WordPress.com mirror because the direct site can be blocked in
GitHub Actions. Codex's adapter implementations are the authority for that
revision; the hands traxxx behavior must not be backported by assumption.

Codex's TPDB adapter resolves a site by name when an id is not configured,
fetches pages with a bearer key, retries HTTP 429 with bounded delays, parses
scene identifiers/dates/durations/posters/performers, and rejects invalid
responses. Its studio-site enrichment uses the same allowlist and metadata
recipes described above. Bang listing/page parsing and rate limiting are in
`src/studios/bang-originals.js`.

Codex's Madouqu path is more audit-oriented than Hands's current adapter. It
uses explicit categories for Madou, Royal Chinese, Peach, Jingdong, Tianmei,
Jelly/91, Xingkong, Elephant, and AiDou; category 1 receives an additional
Royal Chinese title/body prefix check. It classifies posts as `admit`, `review`,
or `excluded`, stores matched keywords and an evidence snippet in provenance,
and retains low-confidence double-penetration posts with `reviewRequired: true`
for manual review. A review result wins over an earlier admission for the same
post id.

### 3. Normalisation and identity

Both applications create a stable scene id from the adapter id and source id:

```text
<adapter-id>:<source-scene-id>
```

Hands performs this in `src/catalogue/normalise.ts` and validates the result
once with `Scene`. The canonical fields are:

- `originalTitle`: source title and stable semantic reference;
- `title`: display title, initially the original and later optionally
  translated;
- `studioId` and display `studio` label;
- `performers`, with source-specific gender/name filtering;
- date-only `releaseDate`, positive `durationSec` or `null`;
- `releaseUrl`, source code, tags, thumbnail;
- `provenance` and per-field provenance; and
- live/dead video links and link-check/matching evidence.

The id is the identity key. A translated display title cannot move or duplicate
a scene, and `originalTitle` is retained. Hands's translation cache key folds
Unicode compatibility forms, accents, case, and punctuation while preserving
non-Latin letters. Codex carries previous translated titles forward by scene id
or original-title alias during a source rebuild and stores its translation cache
separately.

Hands preserves an already stored per-label display name when a source emits a
fresh fallback label. Codex does the equivalent for Madouqu labels. This avoids
renaming a category merely because an optional naming pass was unavailable.

### 4. Translation and display enrichment

Translation is display enrichment, not identity or matching authority. The
original title remains available and the matcher operates on the scene's
display title plus performers according to the implementation's current
contract.

Both implementations run a glossary-first translation pass for formulaic
Chinese terms. If the glossary fully resolves a title, it is cached as
`glossary`. If `OPENROUTER_API_KEY` is present, unresolved titles are sent in
batches to the configured OpenRouter model and cached with an `llm:<model>`
provider. Without a key, or after a timeout/malformed response, the title stays
original and is marked `untranslated`; the source sync does not fail. Hands
runs this pass after sync in `src/enrichment/backfill.ts`; Codex runs it as a
separate post-sync step in `src/translate-run.js`.

Unmapped CJK studio labels can be named by the optional LLM pass. If that pass
is unavailable or fails, the source label remains in place. This is a
configuration-dependent display improvement, not a source or matching rule.

### 5. Candidate retrieval

Candidate queries are intentionally broad; the gate, not query text, decides
identity. The shared query builder (`src/linking/queries.ts` in Hands and the
corresponding Codex matcher modules) can use:

1. up to two normalised performer names;
2. distinctive title keywords;
3. a configured scene code, such as Mambo Perv `OB...`; and
4. the studio name, except for creator studios such as Maximo Garcia, where
   studio-name searches are known to be noisy.

Single-token performer names are allowed. Tags never create a candidate pool,
and upload date is not used as an admission window. It may participate in
ranking after identity has already passed.

Hands resolves sxyprn first and queries eporner only when sxyprn produces no
accepted link. Codex uses the same source priority in its enrichment path. The
Madouqu lane skips both sources because its matcher is explicitly absent.

#### Sxyprn

`src/linking/sxyprn.ts` uses the optional `sxyprn` client. It caches searches and
details within a run, validates watch URLs, applies the duration/identity gate
to search cards, and then fetches post details. The post's own title and
duration must also pass before the URL is stored; an unverified search card is
never exposed as playback.

Sxyprn can be unavailable behind anti-bot/Cloudflare controls. Hands bounds
each call with `LISZT_SXYPRN_TIMEOUT_MS`; a failed sxyprn attempt still allows
eporner to run. Codex has a small source-code override map in
`src/sxyprn-overrides.js` for user-confirmed opaque matches. Those overrides
are maintainer configuration, not a dashboard workflow; they are URL-validated
and still subject to later link re-verification.

#### Eporner

`src/linking/eporner.ts` uses the public REST search API without an API key,
including `length_sec`, canonical watch URLs, and embed URLs. Search results
are deduplicated by URL. If open search misses, the configured trusted-uploader
pool is inspected newest-first. The hand-maintained accounts are
`Vovick17`, `KJUIUI`, `Rafael12021988`, and `wmrt0s`; trust is data, not
auto-promoted from upload counts.

Inside a trusted pool only, first-name identity is permitted and a trailing
MMDD code must agree with the release date within one day. Open search still
requires the full performer-token identity or verbatim title. A trusted pool
supplements open search; it does not replace it.

### 6. Matching, ranking, and decisions

The pure gate in `src/core/matching/index.ts` (Hands) and `src/matching.js`
(Codex) is:

```text
candidate duration within ±2 seconds
AND
(every token of one performer is present in the candidate title
 OR the normalised scene title appears verbatim)
```

Candidate titles are Unicode-normalised (NFKC/NFKD), lower-cased, accent-folded,
and tokenised. A scene with no positive duration cannot pass. For trusted
uploader pools, the alternate identity rule allows a first-name token but
requires the release-date MMDD check described above.

Accepted candidates are collapsed by a title stem that removes common repost
wrappers and decorative date/hashtag material. Ranking then prefers, in order:

1. smallest duration difference;
2. upload date nearest the release date when both dates are available;
3. a candidate with an upload date over one without;
4. higher view count;
5. earlier upload date; and
6. deterministic URL order.

If distinct accepted title stems come from more than one uploader, the matcher
rejects the set rather than guessing. Otherwise it stores the best candidate(s)
allowed by the source matcher.

The following are deliberately **not** acceptance rules: upload date windows,
studio name appearing in the title, thumbnail similarity, tag search, duration
alone, or fuzzy title similarity. The public matching specification records
measurements for these rejected approaches; the implementation omits them to
protect precision.

### 7. Store/update behavior and duplicate prevention

Hands's `scenes.id` is the SQLite primary key. `upsertScene` writes one row per
stable id in a transaction, replacing the source metadata while keeping the
scene's live/dead link collections in the associated tables. The schema also
uses foreign keys and a unique key over scene/link kind/source/URL. A repeated
sync therefore updates the same scene instead of inserting a duplicate.

Codex writes a complete JSON catalogue through a temporary file followed by an
atomic rename. A refresh reconstructs ids as `adapter:sourceSceneId`, carries
translation/label state forward, and writes one current snapshot. Duplicate
source ids collapse through adapter-specific maps where used, such as Bang and
Madouqu.

Neither implementation defines a universal "newer source always wins" policy
for every field. The verified precedence is narrower:

- stable scene id is the identity authority;
- source adapter data is the normal metadata update;
- studio-site values fill missing fields and carry field provenance (Codex's
  enrichment can be configured to refresh existing fields; Hands's ingest path
  fills incomplete TPDB fields); and
- a stored translated display title/label is carried forward so a source poll
  does not erase completed display work.

Hands retains scenes that are absent from a successful source response until
they leave the rolling window; the code does not perform source-specific
in-window deletion. A failed adapter explicitly retains its last-good,
still-in-window records and records `lastError`. Codex rebuilds the snapshot
from successful adapter results, so records omitted by a successful source
refresh disappear from the snapshot; on adapter failure it retains prior
records unless that adapter opts into discard-on-failure (the Madouqu adapter
does). This distinction is important when an upstream removes or temporarily
hides a scene.

### 8. Link updates, removals, and staleness

A scene with a live link is not re-matched on every pass; link verification owns
that link. A scene with no link is retried on later syncs if it has a duration
and a matching lane. A duration-less scene remains unmatched rather than being
admitted through a weaker rule. Hands's no-match/metadata-poor behavior is
silent at the scene level but visible through source/run status and logs.

Each sync re-verifies up to the stalest 25 live links. Sxyprn links are checked
by fetching the watch page. Eporner links are checked with its `video/id` API;
an empty result is definitive deletion. A 404/410 is definitive for sxyprn;
timeouts, 403 anti-bot responses, 5xx responses, malformed bodies, and network
errors are inconclusive and do not count as deletion. Two consecutive
definitive failures move a link from live `videoUrls` to `deadVideoUrls`, where
it remains for history and is hidden from the dashboard. If the last live link
dies, the scene re-enters normal resolution. Previously dead URLs are excluded
from re-adding the same known-dead link.

Codex additionally exposes `/api/video` and `/api/video/resolve` to proxy or
resolve sxyprn playback for a selected scene. Hands returns source links in its
read model; its public API does not define the Codex video proxy routes.

## Representative scene walkthrough

The following is a source-grounded scenario using the Maximo/creator-studio
case documented in `liszt-hands/docs/specs/studio-site-scraper.md`; values are
shown to make the transitions concrete, not as a promise that every Maximo
scene has the same data.

1. TPDB returns a Maximo scene with a stable TPDB id, title, release URL, and
   performer alias such as `Marfe okkk`, but no duration. The Maximo adapter
   accepts the record because its female-performer requirement is satisfied and
   marks the source provenance as TPDB.
2. The release URL points to an allowlisted studio host. The studio-site
   extractor reads the page metadata and fills the missing duration (the
   documented example is 1,418 seconds), recording `durationSec: studio-site`.
   If the page is dead or lacks extractable fields, the record is marked
   metadata-poor and remains unmatched; no duration-less guess is allowed.
3. Normalisation produces an id such as `maximo-garcia:<tpdb-id>`, a date-only
   release date, canonical/original title, performer list, release URL, and
   provenance. The `creatorStudio` flag causes query construction to use the
   performer alias and skip the noisy tube studio-name query; the tube's
   `Onlyfans` label is not used as identity.
4. Sxyprn search returns candidate cards. The matcher requires duration within
   two seconds and performer/title identity. A candidate at 1,418 seconds with
   the `Marfe` identity can pass; other clips from the performer's catalogue at
   the same name but wrong duration/title are rejected. The accepted sxyprn
   card is details-verified before its watch URL is stored. If sxyprn is down,
   eporner gets a turn; if neither source clears the gate, the scene remains
   unmatched.
5. Hands upserts the scene and its live link in SQLite, updates
   `videoCheckedAt` and `videoMatching.rule`, and exposes it from `/api/scenes`.
   Codex writes the equivalent `videoUrls` record to its JSON snapshot. A
   later rotating verification either refreshes `verifiedAt` or, after two
   definitive failures, records a dead-link history entry and retries matching.

For a less favourable but important path, a Madouqu post whose title contains a
low-confidence double-penetration term follows Codex's review path: it is
retained with `reviewRequired`, matched keywords, and an evidence snippet, but
it is metadata-only and receives no playback search. Hands's current
Madouqu classifier instead has no review queue; its stricter classification
admits only `anal sex` and excludes play-only or ambiguous terms.

## Rules and precedence

The effective order, from highest to lowest authority, is:

1. **Schema and source safety.** Invalid ids/dates/required fields, disallowed
   URLs, unsafe redirects, or malformed source responses do not become scenes.
2. **Lane declaration.** `matcher: null` disables playback matching entirely;
   a creator-studio flag changes query construction only, not the identity gate.
3. **Configured source/content filters.** Studio/category selection and
   Madouqu safety/content rules decide which raw records enter the catalogue.
4. **Manual/configured overrides.** Codex's explicit sxyprn override map is
   higher precedence than search for its listed scene ids. It is source code,
   not a user-facing override editor. Hands has no equivalent end-user manual
   link override in the inspected source.
5. **Exact measured gate.** Duration ±2 seconds plus performer-token or
   verbatim-title evidence is required. Trusted-pool first-name matching is a
   deliberately narrower exception scoped to named uploaders and MMDD evidence.
6. **Ranking/tie-breaks.** Duration closeness, date distance, views, and stable
   URL order choose among already accepted candidates; they cannot turn a
   rejected candidate into a match.
7. **Persistence.** Stable id prevents scene duplicates. Existing live links
   are verified, not needlessly replaced; dead history prevents re-adding a
   known dead URL.
8. **Display enrichment.** Glossary/LLM translation and label naming can change
   display text, but failure leaves the original and never fails the source
   sync.

There is no verified precedence rule saying that a newly fetched value always
overwrites a manually confirmed value for every field. Operators should treat
provenance and the source-specific update behavior as authoritative and should
not infer conflict resolution that the code does not implement.

## Failure handling and observability

### Source and network failures

Every HTTP request has a timeout in Hands. Fetch errors distinguish definitive
404/410 deletion from inconclusive timeout/network/5xx/anti-bot failures. The
source adapters apply bounded retries where their upstream supports it (TPDB,
Bang, Madouqu, and traxxx). Concurrency is bounded by the composition root.

During a Hands sync, one adapter failure does not stop other adapters. The
failure becomes a `RunOutcome` with `ok: false` and an error message; the
studio status retains its prior success timestamp, sets `lastError`, and reports
the retained scene count. An empty result is accepted only when the adapter
explicitly says it is verified empty; otherwise it is treated as a suspicious
extraction failure to avoid deleting or replacing data with a parser bug.

Codex records an adapter error in the studio status and continues the other
lanes. Its JSON snapshot retains last-good records for ordinary adapter
failures. A failed translation call degrades to untranslated text. The refresh
workflow can therefore publish a partially refreshed but explicitly
source-health-marked catalogue.

### Logs, statuses, and recovery

Hands emits structured JSON-line logs with timestamps, levels, component
fields, and run information. `/api/studios` exposes per-lane success/error
status and counts; `/api/runs` exposes the recent run ledger; `/api/scenes`
includes live/dead link and matching evidence. The dashboard shows the same
read model and indicates when enrichment/refresh is pending. `GET /api/health`
is a liveness check, not proof that every source is healthy.

The normal recovery actions are to run another refresh after fixing a missing
credential/upstream outage, inspect the affected studio/run status, or restore
the persistent SQLite/JSON data from the operator's backup/snapshot. A failed
source is retried on the next run; a scene without a confident match is also
eligible for later matching when metadata or tube coverage improves. There is
no end-user manual candidate-review screen in Hands. Codex's Madouqu review
metadata and source-code sxyprn overrides are the explicit manual recovery
mechanisms present in the inspected sources.

## Repeat runs and idempotency

Syncs are designed to be safe to repeat:

- deterministic adapter/source ids plus source ids produce the same scene key;
- source result maps and link URL sets deduplicate repeated records/links;
- Hands's SQLite upsert and Codex's atomic snapshot write converge to one
  current record per scene;
- query/pool caches reduce duplicate requests within a run but do not change
  the acceptance rule;
- translation results are cached and reapplied rather than regenerated on every
  boot; and
- re-verification is limited to the stalest link slice, so repeated runs rotate
  checks rather than rechecking the entire catalogue every time.

The result is not a full event-sourced history. A run ledger and provenance are
stored, and dead links are retained, but the source metadata row represents the
latest successful adapter view under each application's update rules.

## Configuration and operation

### Hands

The important environment variables are:

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `LISZT_DB_PATH` | `data/liszt.db` | SQLite file (`SALIERI_DB_PATH` is a legacy fallback) |
| `TPDB_API_KEY` | unset | Required for the TPDB-backed Maximo lane; missing is reported as a calm source status |
| `OPENROUTER_API_KEY` | unset | Optional translation/label enrichment |
| `LISZT_WINDOW_DAYS` | `90` | Rolling window |
| `LISZT_FETCH_TIMEOUT_MS` | `15000` | General HTTP deadline |
| `LISZT_SXYPRN_TIMEOUT_MS` | `15000` | sxyprn call deadline |
| `LISZT_TRAXXX_MIN_INTERVAL_MS` | `250` | traxxx request spacing |
| `LISZT_TRAXXX_CACHE_TTL_MS` | `300000` | traxxx per-run response cache |
| `LISZT_BOOT_SYNC` | `true` | Start a background sync after the server listens |
| `LISZT_LOG_STDERR` | `false` | Send JSON logs to stderr; the CLI enables this |

Run locally with Node 24:

```sh
make install
make dev                 # dashboard on :3000
make sync                # one sync cycle, then exit
make typecheck
make test
```

### Codex

Codex requires Node 20.18.1 or newer. The important variables are:

| Variable | Default | Effect |
| --- | --- | --- |
| `TPDB_API_KEY` | unset | TPDB refresh credential |
| `OPENROUTER_API_KEY` | unset | Optional translations/label names |
| `PORT` | `10000` | HTTP port |
| `LISZT_DATA_PATH` | bundled `data/catalogue.json` | Catalogue JSON path |
| `LISZT_TRANSLATIONS_PATH` | bundled `data/translations.json` | Translation cache path |
| `LISZT_DATA_DIR` | unset | Directory for both JSON files; individual paths win |

Run locally with `npm ci` and `npm start`. A one-off source refresh is
`npm run sync`; `npm run refresh:snapshot` is the snapshot-oriented operation
described by the Codex README. The deployed public server intentionally does
not start a source refresh through HTTP.

## Verified, configuration-dependent, and open

### Verified in the inspected public source

- Stable source-derived scene ids and rolling-window filtering.
- Source-specific metadata parsing and provenance fields listed above.
- Hands SQLite persistence/upsert and Codex atomic JSON snapshots.
- Duration ±2 seconds plus performer/verbatim-title identity gating.
- Sxyprn details verification, eporner REST/embed validation, and trusted
  uploader pool rules.
- Rotating stale-link verification, two-strike definitive deletion handling,
  and retry after the last live link dies.
- Per-source failure isolation, suspicious-empty protection, run/studio status,
  and dashboard/API read models.

### Configuration-dependent behavior

- Which scenes exist depends on the live upstream source responses and the
  configured 90-day (or overridden) window.
- TPDB-backed lanes require `TPDB_API_KEY`.
- LLM translation and label naming require `OPENROUTER_API_KEY`; model choice is
  configurable in Hands and the Codex translation module.
- Sxyprn coverage depends on the optional client and upstream anti-bot access.
- Render persistence, GitHub Actions refresh, repository secrets, and backup
  behavior depend on deployment configuration rather than application code.

### Open questions and explicit limits

- The repositories do not define a data exchange or migration path between
  Codex JSON and Hands SQLite. Running both does not, by itself, merge
  catalogues or link history.
- Tube coverage is empirical and changes as uploads are removed or sources
  become inaccessible; the README should not be read as a completeness claim.
- Hands does not expose a general manual link/candidate review UI. Codex has
  narrow source-code overrides and Madouqu review metadata, but not a general
  operator workflow for resolving every ambiguous tube candidate.
- Successful-source removals differ: Hands retains in-window rows missing from
  a successful response, while Codex rebuilds the snapshot from successful
  adapter output. This is source behavior to account for before operating both
  against the same watchlist.

## Source map

For maintenance, start with these files in the public repositories:

| Concern | Hands | Codex |
| --- | --- | --- |
| Composition/API | [`src/app.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/app.ts) | [`src/server.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/server.js) |
| Sync/update | [`src/sync.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/sync.ts) | [`src/sync.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/sync.js) |
| Canonical schema | [`src/core/schema/index.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/core/schema/index.ts) | catalogue validation in [`src/catalogue.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/catalogue.js) |
| Catalogue registry | [`src/catalogue/registry.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/catalogue/registry.ts) | [`src/studios/index.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/studios/index.js) |
| Matching gate | [`src/core/matching/index.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/core/matching/index.ts) | [`src/matching.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/matching.js) |
| Source query construction | [`src/linking/queries.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/linking/queries.ts) | [`src/sxyprn.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/sxyprn.js), [`src/eporner.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/eporner.js) |
| Link lifecycle | [`src/linking/resolve.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/linking/resolve.ts), [`src/linking/reverify.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/linking/reverify.ts) | [`src/sxyprn.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/sxyprn.js), [`src/reverify.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/reverify.js) |
| Persistence | [`src/core/store/sqlite.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/core/store/sqlite.ts) | [`src/store.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/store.js) |
| Translation | [`src/enrichment/backfill.ts`](https://github.com/bifanaboy/liszt-hands/blob/main/src/enrichment/backfill.ts) | [`src/translate-run.js`](https://github.com/bifanaboy/liszt-codex/blob/main/src/translate-run.js) |
| Authoritative matching notes | [`docs/specs/matching-algorithm.md`](https://github.com/bifanaboy/liszt-hands/blob/main/docs/specs/matching-algorithm.md) | [`README.md`](https://github.com/bifanaboy/liszt-codex/blob/main/README.md) and matching modules |
