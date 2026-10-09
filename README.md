# Liszt

Liszt collects recent releases from configured feeds, combines duplicate records, and finds verified playback links. It is a single Node.js 24 app with a built-in HTTP server and SQLite catalogue.

## Run locally

Set a username and a password of at least 12 characters, then run:

```sh
LISZT_AUTH_USERNAME=owner LISZT_AUTH_PASSWORD='choose-a-long-password' npm start
```

The app listens on `0.0.0.0:$PORT` (default port 3000) and creates or migrates `LISZT_DB_PATH` (default `data/liszt.db` for local runs). The container sets the path to `/data/liszt.db`. It listens before the first refresh completes. Refreshes start every 30 minutes by default; boot and manual refreshes share the same single-flight runner. The catalogue window is 90 days.

## Deploy

The `Dockerfile` builds the same app for each host. Set `LISZT_AUTH_USERNAME` and `LISZT_AUTH_PASSWORD` as private deployment variables; startup fails if either is missing. Configure a persistent disk mounted at `/data` and keep `LISZT_DB_PATH=/data/liszt.db`.

- **VPS:** `docker compose up -d` using `compose.yaml`. The example publishes only to localhost on port 3000; put it behind a reverse proxy that provides HTTPS.
- **Render:** use `render.yaml`, select a paid instance with its persistent disk, and enter both authentication values in the service environment. Disk-backed services run as one instance and have a short restart gap during deployments.
- **Railway:** deploy the included Dockerfile configuration, attach a volume mounted at `/data`, and set both authentication values and `LISZT_DB_PATH`. Attach the volume before the first start so the fresh database is created on persistent storage.

The browser uses HTTP Basic authentication. Do not expose the app over plain HTTP on a public network: Basic credentials are only protected in transit by HTTPS. `/health` is a constant public health check; all other pages, catalogue and diagnostic routes require authentication. Only run one app instance against a SQLite file.

## Backups and shutdown

Back up the SQLite database while the app is stopped, or use SQLite's online backup facility; include any `-wal` and `-shm` files only as part of a consistent SQLite backup. Restore the backup to the persistent disk at `/data/liszt.db` before starting the app. Shutdown stops new HTTP requests, drains timer, boot, and manual refresh work, then closes SQLite. The container has a bounded shutdown window; allow at least 45 seconds before forcibly killing it.

Deployments create a fresh database when no file exists. Liszt does not import a former database catalogue. Old database files are not modified. A fresh catalogue rebuilds releases, playback links, and classification history from the feeds.

## Feeds and matching

Each provider has an adapter for its API, pagination, and record shape. The Traxxx network watchlist includes Bang and keeps records under the studio identities those records report. The ThePornDB watchlist is optional and requires `TPDB_API_KEY`. FC2 detail requests are deliberately paced. Failed feeds retain their last successful catalogue state, while malformed individual records are reported without discarding valid siblings.

Eporner search and Sxyprn search compete as equal playback sources when the optional Sxyprn client is installed. Duration and release date filter candidates, and shared identity, view-count, and date ranking selects among survivors. A surviving candidate without identity evidence may be shown as **Guessed**. Other live links are **Matched**; releases without a live link are **Missing**.

Useful maintenance commands include `npm run catalogue-coverage` and `npm run link-studios`. Their output and credentials should be kept out of public logs and commits.

## Checks

Use Node.js 24. Run `npm test`, `npm run typecheck`, `npm run lint`, and `npm run format:check` before release. A passing local check does not establish that a live deployment is healthy; verify its revision, refresh results, and persistent storage separately.
