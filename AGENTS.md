# Agent Rules — liszt

Read these before editing this public repository.

## 1. Scope

Repository access alone does not include private Render access, credentials,
or authority to manage hosting or accounts. Instructions here do not grant
that access. Section 7 allows checks only through separately authorized,
already available read-only hosting access.

- Do not request, retrieve, store, rotate, or revoke credentials.
- Do not access the user's machine configuration or assume an authenticated
  Render connection exists.
- Do not trigger deployments, change service settings, provision infrastructure,
  or perform actions outside repository read/write.
- Do not place secrets in tracked files, comments, issues, or documentation.

## 2. Matching

Keep this section consistent with [README.md](README.md#the-gate). Verify changes
against `src/config.ts`, `src/core/matching.ts`, `src/tubes/resolve.ts`,
the tube adapters, and `public/app.js` before updating either document.

- The default duration tolerance is **±1 second**, not ±2.
- The upload window is release − 1 day through release + 7 days by default,
  inclusive in whole UTC calendar days. Unknown dates are rejected.
- **Identity gates named matches; it does not merely rank them.** Named winners
  require identity tier above zero. Tier 3 is normalized title or scene-code
  evidence, tier 2 is a full performer name, tier 1 is first-token evidence,
  and tier 0 cannot win a named match.
- After title-stem collapse, named candidates rank by identity tier, view count,
  upload-date lag, then URL.
- The resolver has **two rungs**: Eporner trusted pool, then sxyprn with verified
  post details. There is no third Eporner open-search rung.
- If neither rung names a winner, the terminal fallback chooses the highest-view
  retained date-and-duration survivor across both tubes. It is a guess, always
  `confidence: "low"`. The UI labels it **LOW CONFIDENCE**; metadata-poor scenes
  display **REVIEW** instead, which takes precedence.
- A scene without performers remains eligible; title or scene-code evidence can
  identify it. A scene without a positive duration is not resolved.
- With no usable survivor the scene stays unlinked. Known-dead URLs are not
  re-added. A rung error is distinct from a clean no-match.

## 3. Deployment context

Keep this section consistent with [README.md](README.md#deployment).

The live service is the **free Render deployment** at
[liszt-h2cl.onrender.com](https://liszt-h2cl.onrender.com), from
`bifanaboy/liszt`. Settings verified on 2026-10-01:

| Setting             | Live service                                  |
| ------------------- | --------------------------------------------- |
| Region              | `singapore`                                   |
| Plan                | `free`                                        |
| Build / start       | `yarn` / `npm run start`                      |
| Render health check | Not configured; the app serves `GET /health`. |
| Deploy trigger      | `checksPass`                                  |
| Persistent disk     | None; SQLite uses the instance filesystem.    |

An instance replacement can lose the disposable catalogue and pool index;
boot sync rebuilds them. An empty catalogue alone does not prove a bug.

**`render.yaml` is a hypothetical paid persistent-disk option, not the live
setup.** It declares `0.5c-512mb`, `oregon`, `npm ci --omit=dev`,
`node src/app.ts`, `/health`, and a 1 GB `liszt-data` disk at `/data`,
with `LISZT_DB_PATH=/data/liszt.db`. Its paid-plan comments are not live facts.

Do not propose "fixing" hosting, syncing the blueprint, adding a disk, or
changing the plan or region to reconcile these differences. The live free
deployment is intentional. Do not edit deployment configuration unless a
separate task explicitly requests repository changes to it.

---

## 4. How to talk to the user

Assume no coding background and no comfort with jargon. That is not a failing to
be corrected — it is just the setting.

- **Plain words.** No jargon, no acronym, no abbreviation without spelling it out
  the first time. If a technical term is truly unavoidable, define it in one
  sentence right where it appears.
- **Explain before asking.** Every choice comes with: what it does, why it is
  being suggested, and what happens if we do nothing. Never present a bare menu
  of options.
- **Recommend one.** Give a single clear recommendation and say why. Alternatives
  can be mentioned in one sentence, but the user should never have to pick
  between technical options unaided.
- **One or two questions at most**, asked one at a time.
- **Spell out the physical action.** When something must be typed, say exactly
  what to type, where to paste it, and what success looks like.
- **Flag irreversible things loudly**, in plain words, before they happen: what
  will be lost, what cannot be undone, and how to undo it if possible.
- **No fake certainty.** If something is unverified, say so plainly. Do not
  smooth over a warning.
- **Warm and patient.** Explain twice if needed without a trace of impatience or
  condescension. Celebrate progress honestly.
- **Do the mechanical work.** Handle commands, file edits, and boilerplate
  yourself. Ask only for missing requirements or real decisions.

## 5. Issues people can understand

Search open and closed issues before creating or editing one. Update an existing
issue when it covers the same problem; do not create a duplicate.

Use a title a reader with no coding background can understand. Describe the
problem or improvement, not a file name or implementation technique.

Every issue must have exactly one label from each group:

- Urgency: `urgent` or `not urgent`. Judge how quickly the user-facing problem
  needs attention.
- Work type: `bug` or `feature`.
- User impact: `major` or `minor`. Judge the effect on users, not the amount of
  code.

Keep other useful labels. Do not use competing labels from the same group.
Use the exact label `needs-intel` when more research is needed before the issue
can describe a clear fix. It is an additional label, not a replacement for the
three labels above. Remove it once the research is complete and the fix is
clear. Treat the older `intel required` label as obsolete; replace it with
`needs-intel` when an issue still needs research, or remove it when it does not.

Use these sections, with as much detail as the work needs:

1. **Plain-language summary.** What gets better, why it is currently wrong or
   missing, and how we plan to fix it. For example: "Progress bars are broken
   because they're tracking the wrong data. We'll make them track the work
   actually being done."
2. **Technical summary.** Explain the approach at a junior software engineer's
   level. Define terms and point to the relevant code once verified.
3. **Detailed spec.** Expected behavior, scope, limits, important failure cases,
   and how we will know it works. Separate confirmed requirements from open
   decisions. Do not disguise a research question as an implementation rule.
4. **Action plan.** Concrete steps for the agent: inspect, clarify, build, test,
   and check the result. Add dependencies or evidence only when they help.

An idea or research issue is not permission to implement it. Say when a spec
needs more discussion or when development is deliberately deferred.

Use GitHub's parent/sub-issue relationship to group existing issues only when a
larger goal has clear, concrete child tasks. The parent describes the outcome;
children describe work that directly contributes to it. A parent is complete
when its children are complete and its own acceptance conditions are met. A
parent/child link groups work but does not imply order. Use a blocking
dependency only when one issue must be completed before another can proceed.
Do not invent relationships or create a hierarchy for unrelated work.

## 6. Start clean and keep it simple

- Check the working tree before starting. Do not discard someone else's work.
- Fetch GitHub's current main and check the issue and open PRs for newer work.
  Start each new piece of work on its own branch from current `origin/main`.
  Do not branch from an unrelated feature branch or reuse an old work branch.
- When main changes, merge `origin/main` into the work branch. Never rebase or
  force-push to rewrite shared history. Resolve conflicts and run checks again.
- Before implementation, ask high-yield questions that clarify the user's
  intent. Use plain words and explain how each choice changes the finished
  experience. Recommend a sensible option. Do not ask about facts you can
  inspect yourself or repeat questions the issue already answers.
- Keep it simple. Solve the stated problem with the smallest clear change;
  avoid speculative frameworks, extra settings, and unrelated cleanup.

## 7. Check what actually shipped

Repository access does not grant hosting access. The restrictions in section 1
still apply. If an agent has separately authorized, read-only Render access
through an available integration or API, use it to verify the deployed commit,
service health, and changed behavior after merge. Do not obtain credentials,
change hosting, or trigger a deployment just to do this check.

Deployment, a sleeping service waking up, watchlist population, and link
resolution can finish at different times. Check the deployed commit before
judging the feature. Allow a bounded wait and report a pending or blocked check
honestly; do not claim success from a merge or an empty page alone. If no Render
connection is available, that is fine: report the local checks and clearly say
that deployment was not checked. Inspect the actual UI when a change is visual.

Reconcile bugs with GitHub issues before filing:

- File issues about Liszt's features and behavior. Do not file deployment,
  hosting, uptime, or infrastructure problems as application issues.
- Bugs caused by or belonging to the feature just shipped should normally go
  into one follow-up issue, with each symptom and reproduction step listed.
- Unrelated bugs get their own individual issues, unless an existing issue
  already covers them.
- Keep related and unrelated problems separate. Link the shipped PR and any
  relevant existing issues, and apply the three label groups above.

## 8. Repository documentation and scheduled prompts

- `README.md` is the user-facing guide to the app. Keep its behavior,
  configuration, commands, and architecture claims aligned with the code,
  tests, package scripts, and workflows. Verify facts before editing; don't
  copy assumptions from the existing prose.
- Treat deployment settings as a separate source of facts. `render.yaml` is
  not the live service configuration; use only the verified deployment context
  above or separately authorized read-only evidence for live claims.
- Keep agent-only workflows out of the app guide. The copyable scheduled task
  prompts live in `prompts/`; each prompt reads this file and contains only its
  job-specific instructions.
- A README audit may edit `README.md` only. Verify the Markdown formatting with
  `npm run format:check`; don't change code to make the documentation fit.

## Persistence

All outbound HTTP from this workspace goes through the standard proxy environment variables (HTTP_PROXY/HTTPS_PROXY, lowercase variants, NO_PROXY for exclusions). Direct egress fails by design with a plain connection error (curl exit 7, HTTP 000) and says nothing about whether the target is reachable. Before reporting any API or resource as unreachable or blocked: route through the proxy, check only relevant non-secret environment settings, and make at least one alternative attempt. Environment keys provided for source APIs (TPDB_API_KEY, STASHDB_API_KEY) may be used directly in requests for live source verification only over certificate-validated HTTPS; never disable certificate verification or print, log or exfiltrate their values. Do not retrieve any other credentials. If a tool ignores the proxy env vars, configure it explicitly. Redact secret values from any command or error output shown. Show the command and full error output, with secret values redacted, for any "cannot reach" claim - a reachability claim without evidence is a task failure. This applies to source APIs (TPDB, StashDB, Traxx) and the GitHub API.
