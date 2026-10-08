# Hatchable launch checks

The owner imports current GitHub `main` into Hatchable and keeps the project
private. For an existing project, pull from GitHub, inspect the draft, and
promote it when ready. A merge or import alone is not a verified live launch.
Each new project starts with an empty database; Render data is not transferred.

## Owner actions

1. Review the imported files and Hatchable's validation results. Confirm the
   project remains private and review the draft before promoting it. After a
   repository update, confirm removed files are also absent from the draft;
   local `.d.ts` declarations must not remain under `lib/` or `public/`.
2. Configure `TPDB_API_KEY` privately in project settings if ThePornDB is wanted.
   Do not paste private values into chat, repository files, or logs.
3. Open the app as an authorized project member and click **Refresh now** once.
   Check that progress finishes and the catalogue displays releases. Record
   which feeds succeed or fail; one failed feed must not erase other good data.
4. Allow the next hourly refresh to occur. A listed schedule is not proof of an
   actual clock-triggered run.
5. For Sxyprn, choose and launch the separate relay, verify its outgoing country
   and a real Sxyprn response, then set `SXYPRN_RELAY_URL` and
   `SXYPRN_RELAY_SECRET` privately. Follow [the relay guide](../relay/README.md).
   Trigger a lookup and verify both search and details work through Hatchable.
   Until then, record Sxyprn as pending.

## Authorized agent checks

Follow [AGENTS.md, section 7](../AGENTS.md#7-check-what-actually-shipped).
Use already connected, separately authorized read-only Hatchable tools to
inspect project details, deployed files/version, database schema, registered
functions, scheduled jobs, and native logs. If no connected access is available,
use owner-provided evidence and mark missing checks unverified.

- Confirm the deployed files correspond to the intended GitHub revision;
  distinguish an imported draft from the live deployment.
- Confirm database tables and member-only API access are present. Schema alone
  does not prove that refreshes write data or that the catalogue displays it.
- Inspect the owner's manual refresh and a real hourly run. Record completion,
  feed failures, and worker duration. The full cycle must fit the roughly
  310-second one-shot limit. If it exceeds that limit, smaller persisted steps
  are required before cutover; whole-cycle replay is not per-feed resume.
- Use `view_logs` to inspect unexpected function errors and structured handled
  feed failures. Search `log_output`; a successful request can contain a handled
  failure even when its severity is `info`. Report the run, feed, stage, and
  sanitized summary without reproducing secrets or raw fetched content.
- Check the owner's browser observations of catalogue, progress, and playback
  links, or inspect the interface directly when authorized browser access is
  available. Logs alone do not establish that the interface works.
- Record interruption/replay behavior only when observed; do not deliberately
  interrupt jobs during a read-only audit. Completed writes should persist and
  an expired 10-minute lease permits a later refresh to replay the cycle.

Do not invoke functions, run code or SQL, start refreshes, edit project files,
change settings, promote drafts, or deploy during these read-only checks.

## Record the result

For each check, record **passed**, **failed**, or **unverified**, with the project,
deployed version or revision, observation time, and supporting evidence. Keep
relay setup, real hourly execution, runtime, recovery, and browser behavior
unverified until they have actually been checked. Add the launch evidence to
[issue #156](https://github.com/bifanaboy/liszt/issues/156) before closing it.
