# Liszt

Liszt keeps a rolling watchlist of releases from configured feeds. It combines
provider records into canonical releases, records which provider supplied each
field, and resolves at most one playback link for each release.

## Start locally

Requirements: Node.js 24 and npm.

```sh
npm ci
npm run dev
```

Open <http://127.0.0.1:3000>. Set `TPDB_API_KEY` in the process environment to
enable ThePornDB. Other settings and defaults are listed in [`.env.example`](.env.example).

Useful commands:

- `npm start` runs the server without watch mode.
- `npm test` runs the fixture based suite; it does not call provider sites.
- `npm run typecheck`, `npm run lint`, and `npm run format:check` check the code.
- `npm run calibrate` measures trusted pool matching against current data.
- `npm run catalogue-coverage` reports likely overlap between provider feeds;
  it does not merge or modify releases.
- `npm run link-studios` resolves studio URLs into a checked in declaration.

## Feed and release behavior

Each provider has an adapter that understands its own API, pagination, and
record shape. Adapters emit provider observations into a shared release
pipeline. A new API needs its own adapter; the app does not guess how arbitrary
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
carrying the `anal` tag.
ManyVids reads the configured public stores and keeps only posts carrying the
`anal` tag.

## Playback matching

Named playback links need title or performer identity evidence. Duration and
release date filter candidates; neither alone names a release. The default
duration tolerance is one second. A candidate for a duration range may fall
within one second of either edge. Ranges wider than one second are held for
review. Upload dates must fall from one day before the release through seven
days after it by default; unknown dates are rejected.

The resolver checks the trusted Eporner pool, then sxyprn details when its
optional package is installed. If neither names a candidate, Liszt may show the
best surviving candidate as **LOW CONFIDENCE**. With no usable candidate, the
release stays unlinked. Known dead links are not re-added.

## HTTP routes

- `GET /health` and `GET /api/health` report server health.
- `GET /api/scenes` returns the release catalogue and provenance.
- `GET /api/sources`, `GET /api/runs`, and `GET /api/progress` expose sync status.
- `POST /api/refresh` starts a refresh.

The catalogue is public and the refresh route has no authentication. Do not
expose this service to an untrusted network without adding an access boundary.

## Configuration and hosting

`TPDB_API_KEY` enables ThePornDB. `LISZT_STUDIO_LINKS` accepts a JSON array of
studio declarations; without it, Liszt reads [`studio-links.default.json`](studio-links.default.json).
`LISZT_TRAXXX_WATCHLIST` replaces the built in Traxxx listing URLs. The
ManyVids store list, Bang listing URL, polling window, matching window, and
network limits can also be set through the variables in [`.env.example`](.env.example).

The live deployment is the free Render service at
<https://liszt-h2cl.onrender.com>. It has no persistent disk, so its catalogue
and pool index can be lost when the instance is replaced and rebuilt by sync.
[`render.yaml`](render.yaml) describes a separate paid persistent disk setup;
it is not the live service configuration.

## Repository notes

- [`AGENTS.md`](AGENTS.md) contains repository-specific coding and review rules.
- [`docs/superpowers/specs/2026-10-05-composite-release-repair-design.md`](docs/superpowers/specs/2026-10-05-composite-release-repair-design.md)
  records the composite-feed behavior and its safety rules.
