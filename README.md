# Liszt

A long-running personal release watchlist. On boot and on a timer it polls every
source for scene metadata, keeps a rolling window in SQLite, and resolves **one
verified playback link per scene, or none**.

The safety rule, inherited unchanged from the two projects this replaces:

> **A missing link is preferable to a wrong link.**

An unmatched scene is a valid result, not a failure. Tube coverage is empirical
and changes as uploads are removed or sources become inaccessible - this is not a
completeness claim.

---

## Quick start

```sh
npm install
npm run auth:hash          # masked prompt; paste the output into .env
cp .env.example .env       # then paste LISZT_AUTH_PASSWORD_HASH into it
npm run dev                # dashboard on http://127.0.0.1:3000
```

Node 24+. No build step: TypeScript runs through Node's native type stripping.

| Command | What it does |
| --- | --- |
| `npm run dev` | Watch-mode server. |
| `npm start` | Server. |
| `npm run sync` | One cycle, JSON result on stdout, JSON logs on stderr. |
| `npm run calibrate` | Pool-match measurement. See [Calibration](#calibration). |
| `npm run auth:hash` | Password hash for `LISZT_AUTH_PASSWORD_HASH`. |
| `npm test` | The suite. Fixture-driven, never live network. |
| `npm run typecheck` / `lint` | `tsc --noEmit` / `eslint`. |

The only variable required in production is `LISZT_AUTH_PASSWORD_HASH`. With
`NODE_ENV=production` the server **refuses to start** without it, and refuses to
start with `LISZT_AUTH_DISABLED=true`.

---

## Architecture

```
source adapters          pipeline              tube ladder            serving
─────────────            ────────              ───────────            ───────
traxxx.me   ┐            window filter   ┌──▶ 1 eporner pool  ─┐
Bang!       ├─▶ RawScene ┼─▶ normalise ───┤    2 sxyprn        ─┼─▶ Scene ─▶ SQLite
Maximo      │            per-source       │    3 eporner open   ─┘         │
madouqu     │            isolation        │                                  ▼
fc2cmadb    ┘            upsert by pk     └─▶ re-verify (stalest 25)   read model
                                                   two-strike dead   dashboard + API
```

| Concern | File |
| --- | --- |
| Composition root | `src/app.ts` |
| One sync cycle | `src/pipeline/sync.ts` |
| Scheduling, single-flight | `src/pipeline/scheduler.ts` |
| Canonical schema (the one parse boundary) | `src/core/schema.ts` |
| The measured gate (pure, no I/O) | `src/core/matching.ts` |
| Ladder | `src/tubes/resolve.ts` |
| Link lifecycle | `src/tubes/reverify.ts` |
| Trusted-pool index | `src/tubes/eporner-pool.ts` |
| Sources | `src/sources/` |
| HTTP | `src/serving/http.ts` |

### Sources

Four categories, in `src/sources/registry.ts`.

| Lane | Mechanism | Matcher |
| --- | --- | --- |
| Lancelot Styles Evolution, Mambo Perv, Tushy | `traxxx.me` REST, no auth | yes |
| Bang! Originals | listing + per-video JSON-LD | yes |
| Maximo Garcia | direct scrape, listing URL configured | yes |
| madouqu (9 categories) | WordPress REST + Mandarin classifier | **none** |
| fc2cmadb | stub - interface unconfirmed | yes |

**No API keys.** `traxxx.me` replaced TPDB entirely.

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

One rule, applied to every scene in the catalogue regardless of source. Stated
once, applied three times — trusted pool, sxyprn, eporner open search.

**Eligibility. Both must hold:**

1. Duration within `LISZT_MATCH_DURATION_TOLERANCE_SEC` (default ±2s).
2. Upload date between `release − 1 day` and `release + LISZT_MATCH_DATE_WINDOW_DAYS`
   (default 7). Compared in UTC, in whole calendar days.

**Then, per rung.** Zero survivors → fall through to the next rung. One survivor
→ link it. Several → collapse same-video reposts by title stem, then rank by:

1. **performer in title** — identity tier (below)
2. highest view count
3. smallest upload-date lag
4. URL, purely so the order is total

No rung matches → the scene stays unlinked and is retried on the next cycle.
**A missing link always beats a wrong one.** A candidate with no obtainable
upload date is rejected: it has to be *inside* the window, not merely
un-disproved. A scene with no duration is never matched. A scene with no
performers is still eligible — it simply has one fewer ranking signal.

#### Identity is a ranking signal, not a gate

The pool index holds thousands of videos. At roughly one video per second-value
of duration, a ±2s band is about five second-values, so **~5 unrelated pool
videos share a scene's duration**; the date window then admits 0–2 of them.
Ranking on views alone therefore picks the most popular decoy in a large
fraction of pool matches — not missing links, but confidently wrong ones.

Performer-in-title as a tiebreak costs nothing and removes nearly all of that.
It also closes a real gap the previous gate had: performer data is genuinely
spotty upstream, and under an identity gate a performer-less scene could *never*
match.

| Tier | Meaning |
| --- | --- |
| `3` | The scene title appears verbatim, or the scene code does. Same-phrasing evidence. |
| `2` | A full performer name is present, every token of it. |
| `1` | Only the first token of a performer is present. |
| `0` | Nothing. Still eligible — it just has the weakest claim. |

Tier 1 earns its place because the trusted pool's retitles carry only first
names for multi-performer scenes, so a full-name-only rule would score the whole
trusted pool at 0.

**Residual risk, stated plainly:** decoy exposure is now exactly the set of
matches won with *no* identity evidence. That is why `confidence: "low"` is
redefined to mean tier 0 — the decoy path — and why the run logs a tier
histogram. A rising tier-0 share is the signal to revisit this decision.

**The MMDD proxy is gone.** The `MMDD code in title` check, its
`require-date-evidence` knob, the per-rung gate variants, and the
multi-uploader rejection all existed to make identity *stricter*. With identity
demoted to a tiebreak they have no purpose, and the MMDD check measured as
completely inert on this corpus besides.

Deliberately **not** acceptance rules, and still absent: studio-in-title,
thumbnail similarity, tag search, duration alone, and fuzzy title similarity.
Duration and date are filters, never evidence of a match; identity orders
survivors, it never invents one.

### Sync behaviour

- One source failing does not stop the others; it becomes a run outcome with
  `ok: false`, keeps its last success timestamp, and **retains its last-good
  in-window records**.
- A source returning no scenes *without asserting* `verifiedEmpty` fails the run.
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

## Auth

One shared password, no username, no external identity provider. It is the whole
perimeter, so the details matter:

- Hash format `scrypt$N$r$p$<salt>$<hash>`, parameters inside the string so cost
  can be raised later without invalidating an existing hash.
- Only `sha256(token)` is stored, and sessions are database-backed, so a leaked
  cookie can be revoked. Cookie is `HttpOnly; SameSite=Lax; Secure`.
- **The throttle is consulted before any `scrypt` work.** `scrypt` is
  deliberately CPU-expensive, so a public `POST /login` is a denial-of-service
  vector, not just a guessing risk. A locked-out request never reaches the hash
  function. This ordering is asserted in the tests.
- `POST /login` and `POST /logout` are POST-only plus `SameSite=Lax`, which is
  the CSRF defence. This also covers `POST /api/refresh`.
- `/api/health` is gated: a public liveness endpoint tells a scanner exactly what
  is running, and it is not evidence that the sources are healthy.

---

## HTTP surface

| Route | Method | Purpose |
| --- | --- | --- |
| `/login` | GET / POST | The password splash. |
| `/logout` | POST | Revoke the session row. |
| `/api/health` | GET | Liveness only. Gated. |
| `/api/scenes` | GET | Read model: scenes, sources, window stats, last run. |
| `/api/sources` | GET | Per-source health. |
| `/api/runs` | GET | Recent run ledger. |
| `/api/refresh` | POST | Start or join one cycle. Returns `202` immediately. |
| `/` + static | GET | The dashboard. Gated. |

`/api/sources`, not `/api/studios`: "source" is canonical, and one source may
emit several studio labels. All responses are `no-store`, so the edge never
caches the catalogue, and static serving is path-traversal safe by construction.

The boot sync, the interval, and `POST /api/refresh` all funnel through one
single-flight runner, so two cycles can never overlap against the same database.

---

## Calibration

The pool rung is the loosest gate and it runs first, deliberately: the four
trusted accounts carry most of the traxxx-lane releases. That trade is documented
rather than hidden.

**Measured on the live pool (2026-09):** those uploaders title uploads in an
obfuscated convention — one live title read
`𝐏𝐞𝐧𝐧𝐢𝐞 𝐥𝐚𝐧𝐢𝐲𝐬 𝐰𝐡𝐞𝐫𝐞𝐬 𝐋𝐮𝐧𝐚, 𝐄𝐦𝐲, 𝐁𝐚𝐦𝐲 & 𝐂𝐡𝐞𝐫𝐭𝐲` for a five-performer
scene. That convention is why identity is a *tier* rather than a gate, and why
first-token-only (tier 1) is kept: those retitles would otherwise score 0 and
lose to every decoy.

**Measured on the ±2s band:** across 1,005 indexed pool videos a scene's ±2s
band holds a mean of 3.1 videos, a median of 2, a p99 of 10 and a maximum of 13
— comfortably inside the 40-hydration cap.

So measure before changing anything:

```sh
npm run calibrate
```

It reports four things, and the window's value should be read against all four:

- a **lag histogram**, computed over every duration-*surviving* candidate rather
  than over the winners — a histogram of links you already accepted cannot show
  the tail the window exists to cut off;
- a per-stage **funnel**: considered → duration-passed → date-passed → linked;
- **unknown-date counts**, which is how a rung that cannot supply dates at all
  announces itself rather than looking like an empty catalogue;
- the **identity-tier histogram** of the winners.

The escape hatch is an env var, not a code change. Above roughly three weeks the
rule has stopped doing useful work and should be deleted rather than tuned.

---

## Configuration

Full list with defaults in `.env.example`.

| Variable | Default | Effect |
| --- | --- | --- |
| `LISZT_AUTH_PASSWORD_HASH` | unset | **Required in production.** |
| `LISZT_AUTH_DISABLED` | `false` | Local dev only. Refuses to boot in production. |
| `LISZT_LISTEN_ADDR` | `127.0.0.1` | Loopback by design; override only behind a fronting proxy. |
| `LISZT_DB_PATH` | `data/liszt.db` | SQLite file. |
| `PORT` | `3000` | |
| `LISZT_WINDOW_DAYS` | `90` | Rolling window. |
| `LISZT_POLL_INTERVAL_MINUTES` | `30` | Poll cadence. |
| `LISZT_BOOT_SYNC` | `true` | One sync after listen. |
| `LISZT_FETCH_CONCURRENCY` / `_TIMEOUT_MS` | `4` / `15000` | Outbound bound. |
| `LISZT_TRAXXX_MIN_INTERVAL_MS` / `_CACHE_TTL_MS` | `250` / `300000` | Politeness. |
| `LISZT_MADOUQU_API_BASE` | WordPress.com mirror | The origin is Cloudflare-challenged. |
| `LISZT_MAXIMO_LISTING_URL` | unset | Unset ⇒ that lane reports "not configured", calmly. |
| `LISZT_TRUSTED_UPLOADERS` | the 4 accounts | Curation. Back this up. |
| `LISZT_EPORNER_LQ` | `0` | The API defaults to `1`, which *includes* low-quality. |
| `LISZT_MATCH_DURATION_TOLERANCE_SEC` | `2` | Duration band, identical on every rung. |
| `LISZT_MATCH_DATE_WINDOW_DAYS` | `7` | Upload window's upper bound. Lower bound is fixed at release − 1 day. |
| `LISZT_POOL_FULL_REWALK_DAYS` | `7` | Drift/deletion correction cadence. |
| `LISZT_SXYPRN_TIMEOUT_MS` | `15000` | |
| `LISZT_SESSION_TTL_DAYS` | `30` | Sliding session lifetime. |
| `LISZT_LOGIN_MAX_FAILURES` / `_LOCKOUT_MINUTES` | `10` / `15` | Per-IP, consulted before hashing. |
| `LISZT_LOG_STDERR` | `false` | JSON logs to stderr; the CLI sets it. |

---

## Deployment

Production is **Node 24 under systemd behind a Cloudflare Tunnel**, not Docker.
`Dockerfile` and `render.yaml` exist for local/CI use and as an alternative.

**[`deploy/README.md`](deploy/README.md) is the runbook.** It stands alone:
preflight, DNS/Cloudflare, host preparation, the env reference, deploy, verify,
backup and restore, secret rotation, rollback, log inspection, Node upgrades, and
a security checklist.

The short version: the app binds loopback only, the database lives outside the
repo, the password hash lives in a 640 file, and the edge carries one rate-limit
rule scoped to `/login`.

---

## Relationship to the earlier projects

This is a greenfield rebuild. `liszt-codex` (committed-JSON + GitHub Actions
refresh) and `liszt-hands` (SQLite service) are **superseded references** and are
not modified or imported. Codex supplied the UI that is ported into `public/`;
hands supplied the architecture. Neither is part of this application, and there
is no data exchange between them and this database.

The rebuild exists because the older pair could not do the obvious thing - poll
regularly - and because a scene missing from one snapshot silently vanished.
