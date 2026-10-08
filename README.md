# Liszt

Liszt keeps a rolling catalogue of releases from configured feeds. It combines
provider records into canonical releases, records which provider supplied each
field, and saves at most one verified playback link for each release.

## Run in Hatchable

Liszt is built to run as a Hatchable project. The repository contains its handlers
in `api/`, shared JavaScript in `lib/`, database migrations in `migrations/`,
and the browser app in `public/`. A new project starts with an empty database;
it does not import data from the former Render service.

Keep the Hatchable project private while setting it up. After a GitHub merge,
pull the changed files into Hatchable, inspect the draft, and promote it when it
is ready. A GitHub merge alone does not update the live app. Importing the files
also does not prove that refreshes or playback lookups work; complete the
[launch checks](docs/hatchable-launch-checks.md) before treating the move as
verified.

The owner configures private values in Hatchable's project settings. The
optional settings are:

- `TPDB_API_KEY` enables ThePornDB.
- `SXYPRN_RELAY_URL` is the HTTPS origin of the separate Sxyprn relay.
- `SXYPRN_RELAY_SECRET` is the shared secret for that relay.

Other feed, matching, and request settings have built-in defaults. Do not put
credentials in this repository or in log messages.

## Refreshes and failures

The project schedules a refresh once an hour. The **Refresh now** button uses
the same job path. Refresh status and the catalogue are available to authorized
project members through the app.

Caught feed failures are saved as structured entries in Hatchable's native
function logs. The owner can review them in Hatchable; connected agents can use
the project's authorized read-only log view. Entries identify the run, feed,
stage, time, and a short sanitized summary. Credentials and fetched page bodies
are omitted. Hatchable prunes older logs, and the retention period is not
specified here.

## Feed and release behavior

Each provider has an adapter that understands its API, pagination, and record
shape. A new API needs its own adapter; the app does not guess how arbitrary
URLs work.

When adding a feed, declare a studio policy:

- **Split** keeps the studio identity each record reports. This is the default.
- **Umbrella** assigns every record from that feed to one named identity, such
  as `DreddXXX`.

If the feed cannot identify a studio in split mode, Liszt keeps it under the
feed's own label for review rather than guessing another studio. Existing
provider studio keys remain attached to umbrella records, and provider
observations and field provenance remain available when another feed fails or
omits a field.

Verified duplicate releases are stored once. Shared release URLs are normalized
conservatively; similar titles on unrelated hosts do not merge. Maximo's known
Fansly, ManyVids, and ThePornDB lanes share the `maximo-garcia` studio identity
and can reconcile records with the same normalized title. Matching durations
select the oldest release date. Conflicting durations remain as a min/max
range; a range wider than one second is marked for review and cannot link
automatically.

The Dredd defaults group ThePornDB site IDs `50864`, `39697`, and `81939` under
the Dredd identity, with `DreddXXX` as an alias. Bang! Originals reads the
verified `www.bang.com/videos` JSON-LD listing and its linked release pages.
The TPDB watchlist includes its built-in site list and keeps only scenes
carrying the `anal` tag. ManyVids reads the configured public stores and keeps
only posts carrying the `anal` tag.

## Playback matching

Named playback links need title or performer identity evidence. Duration and
release date filter candidates; neither alone names a release. The default
duration tolerance is one second. A candidate for a duration range may fall
within one second of either edge. Ranges wider than one second are held for
review. Upload dates must fall from one day before the release through seven
days after it by default; unknown dates are rejected.

The resolver checks the trusted Eporner pool, then Sxyprn details when the
relay's URL and secret are configured. If neither names a candidate, Liszt may
show the best surviving candidate as **LOW CONFIDENCE**. With no usable
candidate, the release stays unlinked. Known dead links are not re-added.

The relay is a separate small Node.js service. Its outgoing country must be
verified with a real Sxyprn request before use; one successful request from
Spain has been observed, but a stable host or region has not been selected.
See [`relay/README.md`](relay/README.md) for setup and live-check steps.

## Local checks

Node.js 24 and npm are used for the repository's parity tests and maintenance
tools. They do not start the deployed app.

```sh
npm ci
npm test
npm run typecheck
npm run lint
npm run format:check
```

The tests use local fixtures and do not call provider sites. The `src/` tree is
kept as a behavior reference for the JavaScript Hatchable implementation and
for the local maintenance tools.

## Repository notes

- [`AGENTS.md`](AGENTS.md) contains repository-specific coding and review rules.
- [`docs/superpowers/specs/2026-10-08-hatchable-deployment-design.md`](docs/superpowers/specs/2026-10-08-hatchable-deployment-design.md)
  records the deployment decisions and known limits.
