# Hatchable deployment and repository release

## Plain-language goal

Turn Liszt into a Hatchable application that someone can launch from the public
GitHub repository. Each launched copy gets its own persistent database and
settings. The owner and connected agents can review failures in Hatchable's
native function logs. Remove personal identifying information from the
repository and its Git history before making it public.

## Confirmed decisions

- Use a direct move into Hatchable. Do not maintain a second, parallel Node.js
  application as a long-term deployment.
- Poll feeds automatically once per hour. Keep the manual refresh action.
- Start each Hatchable copy with a fresh database. Do not migrate the current
  Render database, catalogue, links, or run history.
- Use Hatchable's native execution logs for owner and connected-agent review.
  Do not add a separate error page or error table. Write sanitized structured
  log entries for feed failures that the app handles and continues past.
- Keep each Hatchable project private by default. Making the GitHub repository
  public does not itself publish the app.
- Treat Hatchable as the only supported deployment after the move. Do not
  change or operate the existing Render service as part of this work.
- Remove personal names and email addresses from Git author and committer
  metadata, and remove personal-domain references from current files and past
  commits before the repository is made public.
- After a GitHub merge, updating a Hatchable project remains a manual action:
  pull from GitHub, inspect the draft, and promote it when ready.

## Hatchable application shape

Use Hatchable's file-based project structure: JavaScript handlers in `api/`,
shared JavaScript helpers in `lib/`, SQL migrations in `migrations/`, static
assets in `public/`, and agent tools in `mcp/`. Use Hatchable's PostgreSQL
database for releases, provider observations, links, source state, sync runs,
pool index, and refresh progress. Each app copy has its own database.

Port the current feed adapters, release identity and merge rules, playback
matching rules, and catalogue experience. The feed integrations in scope are
the configurable Traxxx watchlist (18 default URLs), optional ThePornDB
(TPDB), configurable ManyVids stores, Maximo Garcia through Fansly, Bang!
Originals, FC2CMADB, Madouqu, and Woodman Casting X (which reads through
Traxxx). The playback integrations are the Eporner trusted pool, optional
Sxyprn detail lookup, and the FC2-specific Eporner lookup. Preserve existing
externally visible behavior unless a Hatchable limit makes it impossible; do
not silently drop an integration or weaken a matching safety rule. Replace
unsupported Node.js, TypeScript build, filesystem, and package dependencies
with supported Hatchable capabilities or plain JavaScript. Keep feed secrets in
Hatchable's secret setup, never in source files or logs.

An hourly scheduled handler starts a refresh. Work must be saved in bounded,
resumable steps to fit Hatchable's scheduled-job limits. The manual refresh uses
the same sync path. The app continues to expose the current catalogue and sync
status behavior through Hatchable routes and its browser interface.

## Failure review and privacy

Unexpected function failures appear in Hatchable's native execution logs.
Recoverable provider failures must also emit a structured log entry containing
the sync run, provider or feed, stage, time, and a concise error summary.
Remove known secret values and omit raw provider responses, request headers,
and credential-bearing URLs. Keep ordinary sync status in the application's
existing run and source state; add no separate error-history store.

Owners review logs in Hatchable. Connected agents review them using Hatchable's
read-only `view_logs` tool, subject to project access. Hatchable stores function
logs, but a retention duration has not been confirmed; do not promise a fixed
retention period. If a guaranteed retention period becomes necessary, bring
that back as a separate design decision.

Before publishing the repository, scan current files and every Git ref for
personal identifiers and secrets. Remove the known personal-domain reference
from the product audit prompt and remove its historical copies. Replace author
and committer names and emails across the history with neutral project
identities while preserving file contents, commit messages, and timestamps.
Verify the rewritten history no longer contains the removed values. This
rewrites commit IDs; existing clones must be recreated, and old copies retain
their history.

## Release sequence

1. Build and check the Hatchable-compatible app while the repository is still
   private.
2. Verify the platform accepts the project and that a private Hatchable copy
   can load its database, refresh feeds, display the catalogue, and expose
   failures in native logs to the owner and an authorized agent.
3. Remove personal information from current content and rewrite the private
   Git history. Audit the resulting repository before changing visibility.
4. Make the GitHub repository public, then import its default branch into
   Hatchable. The resulting app remains private until its owner chooses to
   publish it.
5. For later changes, merge on GitHub, manually pull in Hatchable, review the
   draft, and promote it when ready.

The Render deployment is not maintained as a second runtime. The repository's
Render-specific setup and hosting claims must not be presented as the supported
deployment after the move. No Render service settings or deployments are part
of this design.

## Acceptance criteria

- A public GitHub repository imports as a Hatchable project without a Node.js
  server, TypeScript build, or unsupported dependency installation.
- A new project starts with an empty database and can populate the current
  rolling catalogue through hourly and manual refreshes.
- Existing release identity, provider provenance, link verification, and
  playback matching safety behavior remain intact.
- Long refresh work resumes safely across bounded scheduled steps; a failed
  provider does not erase good data from other providers.
- Unexpected function errors and caught feed failures are visible in Hatchable's
  native logs, including enough context for the owner and authorized agents to
  identify the failing provider and sync stage.
- Logs do not contain source API keys, authorization headers, or raw provider
  payloads.
- Current repository content and Git history contain no personal-domain
  references, personal author or committer names/emails, or secrets before the
  repository visibility changes.
- Hatchable's Git pull produces a draft for review; promoting that draft is a
  human action.

## Known limits

- Hatchable prunes older native function logs; the exact retention duration
  is not stated in the available platform skill.
- Each launched instance begins without the current Render data. Its catalogue
  and indexes must be rebuilt from feeds.
- The existing Render service and settings are not inspected or changed here.
  Moving the source runtime makes Render an unsupported deployment and may
  affect it if a later repository merge triggers its configured auto-deploy.
- Hatchable's execution time, network, package, and filesystem limits may
  require adapting the named feed and playback integrations. Any integration
  that cannot be preserved within those limits must be surfaced for a scope
  decision before cutover.
