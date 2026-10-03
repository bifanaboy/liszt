# Liszt

A long-running personal release watchlist. On boot and on a timer it polls every
source for scene metadata, keeps a rolling window in SQLite, and resolves **one
playback link per scene, or none**.

Named matches require identity evidence. If neither tube can name the scene,
the resolver may provide a guess explicitly marked **LOW CONFIDENCE**.

An unmatched scene is a valid result, not a failure. Tube coverage is empirical
and changes as uploads are removed or sources become inaccessible - this is not a
completeness claim.

---

## Quick start

```sh
npm install
cp .env.example .env       # optional: every value has a default
npm run dev                # dashboard on http://127.0.0.1:3000, no login
```

Node 24+. No build step: TypeScript runs through Node's native type stripping.

| Command                           | What it does                                             |
| --------------------------------- | -------------------------------------------------------- |
| `npm run dev`                     | Watch-mode server.                                       |
| `npm start`                       | Server.                                                  |
| `npm run calibrate`               | Pool-match measurement. See [Calibration](#calibration). |
| `npm test`                        | The suite. Fixture-driven, never live network.           |
| `npm run typecheck` / `lint`      | `tsc --noEmit` / `eslint`.                               |
| `npm run format` / `format:check` | Prettier. See the note below.                            |

There is no password and nothing to configure to start it. See
[No perimeter](#no-perimeter) for why, and [Deployment](#deployment) for the one
supported target.

Formatting is Prettier at `printWidth: 100`, the column the code was already
written to, and `format:check` runs in CI. `.prettierignore` holds back what must
not be rewritten: `test/fixtures` are byte-captured responses from live pages that
the parser tests assert on exactly; `public/` is the ported dashboard UI as it
arrived, with a one-line 12KB `styles.css`; and `package-lock.json` is npm's to
write.

What the tools read under `public/` is deliberately split. `npm run lint` parses
the browser JS the app ships — `public/app.js` and the modules it imports,
`public/source-health.js` and `public/catalogues.js`, with `app.js` the sole
`<script>` tag in `index.html` — so a syntax error in any of them is caught
before it can white-screen the dashboard. Those files run with `no-undef` off,
since the browser globals they use are not defined in Node and there is no
`globals` dependency to name them; the rule cannot tell browser globals from
other undeclared identifiers, so what that costs is any `no-undef` check at all
over the two files — a misspelled global, and equally a renamed local helper or
a binding deleted at its call site. `public/index.html` and `public/styles.css`
are still read by no tool: not JavaScript, and not reformatable without
rewriting vendored UI. `public/` remains a verbatim port, not hand-maintained
code.

`format:check` also covers Markdown and YAML — `README.md`, `render.yaml` and
the workflow file are all in scope. Since Render will not deploy while a
required check fails, an unformatted docs-only edit blocks deploys exactly as a
broken build does. Run `npm run format` before pushing any of them.

---

## Architecture

```
source adapters          pipeline              tube ladder            serving
─────────────            ────────              ───────────            ───────
traxxx.me   ┐            window filter   ┌──▶ 1 eporner pool  ─┐
Bang!       ├─▶ RawScene ┼─▶ normalise ───┤    2 sxyprn        ─┼─▶ Scene ─▶ SQLite
Maximo      │            per-source       │    guess fallback   ─┘         │
ManyVids    │
madouqu     │            isolation        │                                  ▼
fc2cmadb    ┘            upsert by pk     └─▶ re-verify (stalest 25)   read model
                                                   two-strike dead   dashboard + API
```

| Concern                                   | File                        |
| ----------------------------------------- | --------------------------- |
| Composition root                          | `src/app.ts`                |
| One sync cycle                            | `src/pipeline/sync.ts`      |
| Scheduling, single-flight                 | `src/pipeline/scheduler.ts` |
| Canonical schema (the one parse boundary) | `src/core/schema.ts`        |
| The measured gate (pure, no I/O)          | `src/core/matching.ts`      |
| Ladder                                    | `src/tubes/resolve.ts`      |
| Link lifecycle                            | `src/tubes/reverify.ts`     |
| Trusted-pool index                        | `src/tubes/eporner-pool.ts` |
| Sources                                   | `src/sources/`              |
| HTTP                                      | `src/serving/http.ts`       |

### Sources

Five categories, in `src/sources/registry.ts`.

| Lane                                         | Mechanism                             | Matcher  |
| -------------------------------------------- | ------------------------------------- | -------- |
| Lancelot Styles Evolution, Mambo Perv, Woodman Casting X, Traxxx watchlist | `traxxx.me` REST, no auth             | yes      |
| Bang! Originals                              | listing + per-video JSON-LD           | yes      |
| Maximo Garcia                                | direct scrape, listing URL configured | yes      |
| ManyVids creator stores                      | public JSON list, full and incremental pulls | yes |
| madouqu (11 categories)                      | WordPress REST + Mandarin classifier  | **none** |
| fc2cmadb                                     | stub - interface unconfirmed          | yes      |

**No API keys.** `traxxx.me` replaced TPDB entirely.

Traxxx watchlist entries use this exact grammar:
`https://traxxx.me/(network|channel)/<slug>/scenes/latest/1`, with an optional
`?tags=<slug>[,<slug>...]`. Other hosts, sorts, pages, and query parameters are
rejected at startup. The built-in entry is the Vixen network filtered to the
`anal` tag. `LISZT_TRAXXX_WATCHLIST` accepts a comma-separated list of entries
and replaces that built-in list rather than appending to it, which makes a
single lane easy to isolate during calibration.

**Woodman Casting X** is a traxxx channel lane like the two above, with one
exclusion: the studio writes `XXXX` as a whole token in the scene title of the
scenes it marks, and those are dropped before the record is parsed. The marker
comes from traxxx's title, which is the studio's own title — not from the studio
page, whose own chrome repeats "Woodman casting X" on every scene. The match is
delimited, so real titles such as `Shania VegaX casting`, `Lexxxus Adams
casting` and `- BTS -` scenes stay eligible. See `src/sources/woodman-casting-x.ts`.

Two things are load-bearing and must not be "simplified" away:

- **The traxxx filter guard.** traxxx silently ignores an unknown `e=` filter and
  returns the entire ~500k index. The adapter compares the filtered total to the
  unfiltered total, throws when they are equal, and re-checks every record's
  entity slug. One typo would otherwise ingest the whole catalogue as one studio.
- **The madouqu classifier.** Only titles classified as anal sex are admitted;
  safety, trans/gay, non-anal and play-only terms are excluded, and title
  evidence is stored in provenance. The lane sets `matcher: null`, so its scenes
  are metadata only and never enter tube matching.

### The gate

The shared rules are implemented in `src/core/matching.ts`, configured in
`src/config.ts`, and applied by both rungs in `src/tubes/resolve.ts`.

**Candidate filters. Both must hold:**

1. Duration within `LISZT_MATCH_DURATION_TOLERANCE_SEC` (default **±1 second**).
2. Upload date between `release − 1 day` and `release + LISZT_MATCH_DATE_WINDOW_DAYS`
   (default 7), inclusive in whole UTC calendar days. Unknown dates are rejected.

**Identity gates named matches; it also ranks them.** After date and duration
filtering, candidates collapse by title stem. A named winner must have an
identity tier above zero; even a sole survivor cannot become a named match
without identity evidence. Named survivors rank by identity tier, highest view
count, upload-date lag, then URL.

| Tier | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| `3`  | Normalized scene title appears in the candidate title, or all scene-code tokens are present. |
| `2`  | All tokens of a full performer name are present.                                             |
| `1`  | A performer's first token is present, including supported name-plus-date-code forms.         |
| `0`  | No identity evidence; cannot win a named match.                                              |

Tier 1 is accepted; a full-name-only rule would reject useful first-name
retitles. A scene without performers is still eligible: title or scene-code
evidence can identify it. A scene without a positive duration is not resolved.

### Two rungs and a guess fallback

`src/tubes/resolve.ts` tries, in order:

1. **Eporner trusted pool** — date and duration filters, then the identity gate.
2. **sxyprn** — search cards, verified post details, then the same identity gate.

A named winner stops resolution and receives `confidence: "high"`. If a rung
cannot name a candidate, resolution proceeds to the next tube. There is no
third Eporner open-search rung.

If neither rung produces a named winner, the terminal fallback picks the
highest-view candidate from the retained date-and-duration survivors across
both tubes. Unknown view counts rank below known counts; URL breaks ties.
This is a **guess**, always saved as `confidence: "low"`, not an identity-backed
match. The UI in `public/app.js` labels it **LOW CONFIDENCE**; metadata-poor
scenes display **REVIEW** instead, which takes precedence.

A rung error lets the other rung run but contributes no fallback candidates;
it is not recorded as a clean no-match. With no usable survivor the scene stays
unlinked for a later cycle. Known-dead URLs are never re-added.

A tube that keeps failing is held off by a circuit breaker rather than retried
per release, so a broken source costs a bounded number of requests per cycle
instead of one deadline per release. The break is reported separately from the
failure that opened it, and each rung's failures are counted on their own, so a
held-off tube is distinguishable in the logs from a live timeout.

`/api/runs` stores resolver rejection counters separately from catalogue-source
outcomes. A resolver outage therefore does not mark healthy catalogue polling
as failed, and the dashboard reports resolver unavailability independently.

The sxyprn rung is **paced by its own package**, which honours the site's
`Crawl-delay: 10` and will not answer more than six requests a minute. So the
rung asks for one request at a time and starts its per-call deadline only once
that request reaches the front of the queue. That distinction is the whole fix
for the run of `sxyprn search timed out after 15000ms` in production: the ladder
fans several scenes out at once, and a deadline that counted the package's own
10-second spacing expired on healthy calls that had not been asked yet. Waiting
for the source is not a failure, so it is not reported as one, and it is not
charged to the deadline that exists to bound a request that never answers.

Requests to that source are counted per cycle and stored on the run row as
`sxyprnSearches` and `sxyprnDetails`, split by pass. Each request costs the
source's ten-second spacing, so that count is what says how long a refresh took;
the ladder's own `attempted` and `errored` counters cover both tubes and cannot
answer it. The dashboard shows the total as **slow-source lookups**, beside the
rung's failures. Counting happens where the request is issued, so a call held
off by the circuit breaker and a search answered from the in-memory cache both
cost nothing and count as nothing.

The rung's winners are also counted on the run row, split by where they came
from: `winnerPool` and `winnerSxyprn` are the links each tube actually named, and
`winnerFallback` is the number of flagged guesses. `matched` is one figure over
both — a named match and a guess are both stored as links — so this split is what
makes the headline number readable, and the dashboard shows the guess count on the
same line as the truncation and request readings.

The trusted pool searches a bounded number of candidates per scene, so a scene
with more survivors than that budget is **truncated, not exhausted**. Those
searches are counted as `incomplete`, never as a clean no-match: the candidates
past the cut were never examined, so the counter states what is actually known.
The dashboard reports them as **search truncated** beside any rung error. The
candidates that were examined still rotate on the next run — least-recently-
attempted first, for both the hydration budget and the rows pulled from SQLite —
so a late candidate becomes reachable rather than being cut off permanently.

Rows whose upload date is known are narrowed by the running time in the database
query, with the same tolerance the gate itself uses, so an account holding
thousands of dated uploads cannot spend the whole scan budget on rows the gate
would reject for free. Those are the rows that need no rotation, and behind them
sit the undated rows — the ones still waiting for a date from the video API — so
narrowing early is what keeps that working set reachable at all. A row with no
recorded running time is still examined rather than assumed away.

### Sync behaviour

- One source failing does not stop the others; it becomes a run outcome with
  `ok: false`, keeps its last success timestamp, and **retains its last-good
  in-window records**.
- A source returning no scenes _without asserting_ `verifiedEmpty` fails the run.
  This is what stops a parser bug from replacing a catalogue with silence.
- Deletion happens only on window expiry. A scene missing from a successful
  response is kept until it leaves the window.
- Upserts are keyed on the stable id `<source-id>:<source-scene-id>`, so a repeat
  sync converges instead of duplicating.
- A scene with a live link is not re-matched; re-verify owns it. A scene with no
  link is retried on later cycles. A scene with no duration stays unmatched
  rather than being admitted through a weaker rule.

### Link verification

Each cycle re-verifies the stalest 25 links. eporner is checked through
`video/id`, where an empty result is a definitive deletion. **Only a definitive
non-existence counts as a strike** - timeouts, 403 anti-bot walls, 5xx, and
malformed bodies are inconclusive and never count. Two consecutive definitive
failures move a link to dead history; if a scene's last live link dies it
re-enters resolution. Known-dead URLs are never re-added.

---

## No perimeter

**There is none.** Every route is served to anyone who can reach the port,
including `POST /api/refresh`. That is the deliberate shape of this deployment,
not an oversight left behind by a removed feature.

The reasoning, once, so it is not re-litigated: this is a disposable public read
model. It holds no user data, no accounts, no personal state, no credentials and
no secrets — the one secret it ever had, a shared login password, is gone along
with the `sessions` table and the scrypt verifier. A password in front of a
catalogue of public video links protects the catalogue from nobody: the links are
already public, and the data behind them is already on the open web.

What the app _does_ do with that posture:

- **No credentials exist.** Nothing to leak, rotate, or forget. `render.yaml`
  contains six non-secret values and there is nothing to type into the dashboard.
- **`/health` is answered before anything else**, from a constant
  `{"status":"ok"}` with no store or source state in it. It is Render's deploy
  gate, and a health check that leaked anything would leak it to whoever felt
  like asking.
- **`/api/health` is a different route and it is stateful.** That is the entire
  reason `/health` exists separately.
- **Refresh is single-flight**, so a caller cannot stack cycles or multiply the
  external request volume beyond one at a time. Sustained traffic against
  `POST /api/refresh` is the accepted cost of being public; if that ever matters,
  the cheapest lever is deleting that one route.

---

## HTTP surface

| Route          | Method     | Purpose                                                                |
| -------------- | ---------- | ---------------------------------------------------------------------- |
| `/health`      | GET / HEAD | Liveness only. Contentless by design; nothing else is evaluated first. |
| `/api/health`  | GET        | Liveness with a timestamp. A different route, and a stateful one.      |
| `/api/scenes`  | GET        | Read model: scenes, sources, window stats, last run.                   |
| `/api/sources` | GET        | Per-source health.                                                     |
| `/api/runs`    | GET        | Recent run ledger.                                                     |
| `/api/refresh` | POST       | Start or join one cycle. Returns `202` immediately.                    |
| `/` + static   | GET        | The dashboard.                                                         |

Nothing is gated, and nothing sets a cookie — the session layer is gone. `/login`
and `/logout` are not routes: they fall through to the normal unknown-path 404.

`/api/sources`, not `/api/studios`: "source" is canonical, and one source may
emit several studio labels. All responses are `no-store`, so no edge caches the
catalogue, and static serving is path-traversal safe by construction.

The dashboard's release ledger has two pages, **Catalogue** and **Asian**. The
Asian-language lanes — fc2cmadb and madouqu — have their own page, so the main
list is not mostly Japanese-language titles; `/api/scenes` carries their ids as
`asianSourceIds` so the split is decided by the registry rather than by a UI
string list. Membership is by `sourceId`, so every sub-label of a lane follows
its lane. Each page counts its own figures — releases in the window, releases
with a link, and the linking percentage — from the rows it shows, and exports
only those rows. `LAST REFRESH` stays shared: a cycle refreshes every lane.

The boot sync, the interval, and `POST /api/refresh` all funnel through one
single-flight runner, so two cycles can never overlap against the same database.

---

## Calibration

The trusted pool runs first. Both rungs use the same default ±1-second duration
tolerance and require identity evidence for named matches. The fallback is
always low confidence; views cannot establish identity.

So measure before changing anything:

```sh
npm run calibrate
```

It reports four things, and the window's value should be read against all four:

- a **lag histogram**, computed over every duration-_surviving_ candidate rather
  than over the winners — a histogram of links you already accepted cannot show
  the tail the window exists to cut off;
- a per-stage **funnel**: considered → duration-passed → date-passed → linked;
- **unknown-date counts**, which is how a rung that cannot supply dates at all
  announces itself rather than looking like an empty catalogue;
- the **identity-tier histogram** of the winners.

The escape hatch is an env var, not a code change. Above roughly three weeks the
rule has stopped doing useful work and should be deleted rather than tuned.

---

## ManyVids and catalogue coverage

ManyVids imports the **full public video list**, starting with Maximo Garcia's
store (`1003095958`). `LISZT_MANYVIDS_STORE_IDS` accepts comma-separated store ids;
add `1008105753` for Filou Fitt, or set it explicitly empty to disable the source.
Each store has its own source health and failure isolation. Store owners are not
assumed to appear in every video; performer names remain unknown unless supplied.

The first poll and a poll every seven days walk every page. Between full pulls,
paging stops after a page containing only known video ids. Requests start at least
400 milliseconds apart per store. Successful snapshots and known ids survive
restarts in SQLite; a failed page leaves the snapshot and full-pull date untouched.
As with other sources, catalogue rows remain until they leave the rolling window.

The scene response keeps the store id, original UTC launch timestamp, UTC release
day, runtime in seconds, price (`regular`, `onSale`, `free`), thumbnail and preview
URLs, and known tags. Preview clips are metadata, never verified playback links.
The endpoint currently omits tags: we leave those unknown rather than fetching
hundreds of tag-filtered lists each run. Tags never limit ingestion. Hidden and
club-only videos are outside this public source; endpoint changes fail the poll
and preserve last-good records.

For the union-coverage audit in #20, run `npm run catalogue-coverage`. It compares
ManyVids and Traxxx records in the local rolling window. TPDB and StashDB are
reported as unavailable because this app has no adapters for them. To compare all
four databases, pass normalized JSON exports:

```sh
npm run catalogue-coverage -- --tpdb tpdb.json --stashdb stashdb.json --traxxx traxxx.json --manyvids manyvids.json
```

Each export is an array of `{ id, title, releaseDate, durationSec }` records (or an
object with a `scenes` array). Dates must be `YYYY-MM-DD`; durations are seconds.
A supplied empty array means checked and empty; an omitted provider means unknown.
Export dates/windows should cover the same period for meaningful comparison.

The report contains likely release groups, the union count, and each provider's
share of that union. Associations require title token similarity of at least 80%,
release dates within two UTC days, and positive runtimes within three seconds.
This runtime margin covers the 50:50–50:53 example in #46 and applies only to the
catalogue audit; playback matching keeps its existing ±1-second tolerance.
Ambiguous candidates remain separate; every record in a group must agree with
every other. These are conservative estimates for review, not a completeness
claim. Original titles, dates and runtimes remain in the report; it chooses no
provider precedence and does not merge or rewrite stored scenes.

---

## Configuration

Full list with defaults in `.env.example`. There is no credential and no
required variable: everything has a working default.

| Variable                                         | Default              | Effect                                                                |
| ------------------------------------------------ | -------------------- | --------------------------------------------------------------------- |
| `LISZT_LISTEN_ADDR`                              | `127.0.0.1`          | Loopback by default; `render.yaml` overrides it for Render's proxy.   |
| `LISZT_DB_PATH`                                  | `data/liszt.db`      | SQLite file.                                                          |
| `PORT`                                           | `3000`               |                                                                       |
| `LISZT_WINDOW_DAYS`                              | `90`                 | Rolling window.                                                       |
| `LISZT_POLL_INTERVAL_MINUTES`                    | `30`                 | Poll cadence.                                                         |
| `LISZT_BOOT_SYNC`                                | `true`               | One sync after listen.                                                |
| `LISZT_FETCH_CONCURRENCY` / `_TIMEOUT_MS`        | `4` / `15000`        | Outbound bound.                                                       |
| `LISZT_TRAXXX_MIN_INTERVAL_MS` / `_CACHE_TTL_MS` | `250` / `300000`     | Politeness.                                                           |
| `LISZT_TRAXXX_WATCHLIST`                        | Vixen `anal` listing | Comma-separated listing URLs; setting it replaces the built-in list.  |
| `LISZT_MADOUQU_API_BASE`                         | WordPress.com mirror | The origin is Cloudflare-challenged.                                  |
| `LISZT_MANYVIDS_STORE_IDS` | `1003095958` | Public ManyVids stores; comma-separated, explicitly empty disables. |
| `LISZT_MANYVIDS_MIN_INTERVAL_MS` | `400` | Minimum spacing between request starts per ManyVids store. |
| `LISZT_MAXIMO_LISTING_URL`                       | unset                | Unset ⇒ that lane reports "not configured", calmly.                   |
| `LISZT_TRUSTED_UPLOADERS`                        | curated account list | Comma-separated Eporner accounts trusted for matching.                |
| `LISZT_EPORNER_LQ`                               | `0`                  | The API defaults to `1`, which _includes_ low-quality.                |
| `LISZT_MATCH_DURATION_TOLERANCE_SEC`             | `1`                  | Duration band, identical on every rung.                               |
| `LISZT_MATCH_DATE_WINDOW_DAYS`                   | `7`                  | Upload window's upper bound. Lower bound is fixed at release − 1 day. |
| `LISZT_POOL_FULL_REWALK_DAYS`                    | `7`                  | Drift/deletion correction cadence.                                    |
| `LISZT_SXYPRN_TIMEOUT_MS`                        | `15000`              |                                                                       |
| `LISZT_LOG_STDERR`                               | `false`              | JSON logs to stderr; the CLI sets it.                                 |

---

## Deployment

**The live service is the free Render deployment**, at
[liszt-h2cl.onrender.com](https://liszt-h2cl.onrender.com), backed by this
repository. Its settings were verified on 2026-10-01:

| Setting             | Live service                                  |
| ------------------- | --------------------------------------------- |
| Region              | `singapore`                                   |
| Plan                | `free`                                        |
| Build               | `yarn`                                        |
| Start               | `npm run start`                               |
| Render health check | Not configured; the app serves `GET /health`. |
| Deploy trigger      | `checksPass`                                  |
| Persistent disk     | None; SQLite uses the instance filesystem.    |

The catalogue and pool index are disposable and rebuild through boot sync.
An instance replacement can lose the database; inspect sync status before
interpreting an empty catalogue as a bug.

**[`render.yaml`](render.yaml) is a hypothetical paid persistent-disk option,
not the live setup.** It currently declares `0.5c-512mb`, `oregon`,
`npm ci --omit=dev`, `node src/app.ts`, `/health`, and a 1 GB `liszt-data`
disk mounted at `/data`, with `LISZT_DB_PATH=/data/liszt.db`. Its paid-plan
comments do not describe the current live service.

Do not propose syncing that blueprint, adding a disk, changing plans or regions,
or "fixing" hosting to reconcile the difference. The live free deployment is
intentional. Hosting changes require a separate explicit task.

For repository coding agents, deployment settings are documentation context
only: agents have repository read/write access, not private Render access or
credential-management authority. Keep these deployment and matching facts
consistent with [AGENTS.md](AGENTS.md), checking the source files before edits.

---

## Relationship to the earlier projects

This is a greenfield rebuild. `liszt-codex` (committed-JSON + GitHub Actions
refresh) and `liszt-hands` (SQLite service) are **superseded references** and are
not modified or imported. Codex supplied the UI that is ported into `public/`;
hands supplied the architecture. Neither is part of this application, and there
is no data exchange between them and this database.

The rebuild exists because the older pair could not do the obvious thing - poll
regularly - and because a scene missing from one snapshot silently vanished.

## Documentation and contributor guidance

This guide describes the app and its supported local workflows. When it may
disagree with the implementation, verify behavior against the source, tests,
package scripts, and workflows before changing the guide. Repository-wide agent
rules are in [AGENTS.md](AGENTS.md); scheduled maintenance prompts are in
[`prompts/`](prompts/).
