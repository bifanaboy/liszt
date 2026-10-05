# SDD ledger — plan: docs/superpowers/plans/2026-10-05-composite-release-repair.md

Plan: `docs/superpowers/plans/2026-10-05-composite-release-repair.md`
Spec: `docs/superpowers/specs/2026-10-05-composite-release-repair-design.md`
Workspace: `/workspace/liszt-repair`
Base: `7684dd0` on `origin/main`
Execution: native sequential; tasks 1–8 completed, then fresh-context review and one fix pass.

## Delivered tasks

- Task 1: source and merge rules agreed; verified Bang capture and documented the Maximo ordering and duration-range decisions.
- Task 2: configuration wiring and static-check failures repaired. Focused source and CLI checks passed.
- Task 3: provider observations persisted; migration preserves release IDs, links, dead-link history, and resolver state.
- Task 4: shared conservative identity and canonical release reconciliation implemented; read-model duplicate merging removed.
- Task 5: split/umbrella studio policy, Maximo composite, TPDB aliases, and Bang JSON-LD adapter implemented.
- Task 6: duration ranges, range-aware matching, review holds, field provenance, and dashboard display implemented.
- Task 7: variable names and docs trimmed; five completed plans removed; local Markdown links checked.
- Task 8: typecheck, lint, formatting, full suite, HTTP smoke, populated browser/API check, and fresh-context review completed.

## Decisions and costs if wrong

- Maximo matching durations use the oldest provider release date; configured source priority and provider ID break ties. The user chose the date rule. If that interpretation is wrong, the displayed release date may be earlier than intended.
- A duration spread above one second requires review. No production data was available to measure typical spread; if one second is too narrow, some safe releases will wait for review.
- Default studio links resolve relative to `src/config.ts` with `import.meta.url`; the old `__dirname` path points above the repository under native type stripping. If this path ruling is wrong, the optional default studio declarations may not load.
- TPDB pagination uses Laravel's `meta.last_page`. If the live API differs from the verified contract, a catalogue walk could stop too early.
- On reconciliation, an ID established before the current sync outranks a newly joined provider's preferred rank. This preserves links/bookmarks across feed changes; if wrong, source-priority identity may not select the row ID.

## Fresh review and fix pass

Reviewer: isolated `final_review` context, gpt-6-astra/high; reviewed `7e82faa..2f530e5` against the plan, spec, ledger, and Review Focus. No Critical findings.

- Important: excluding the canonical provider left an orphan duplicate — fixed by keeping provider observations associated with canonical IDs; regression watched fail, then pass.
- Important: singleton polls dropped retained values — fixed by rebuilding singleton scenes from observations; regression watched fail, then pass.
- Important: migration-era TPDB rows duplicated native site rows — fixed by adopting the verified site observation; regression watched fail, then pass.
- Important: assigned studio and provider studio keys were conflated — fixed by grouping on assigned identity and retaining TPDB native site identity; umbrella and reassignment regressions watched fail, then pass.
- Important: verified studio-page fields disappeared during reconciliation — fixed by storing page evidence separately from original provider values and merging it with field provenance; regression watched fail, then pass.
- Important: TPDB Maximo titles bypassed the shared exclusion — fixed with provider-scoped exclusion records; regression watched fail, then pass.
- Important: Bang pagination ignored escaped ampersands — fixed by decoding the attribute before URL parsing; regression watched fail, then pass.
- Important: a new higher-priority provider changed an established ID — fixed by preferring IDs present before the current cycle; regression watched fail, then pass.

## Deferred minor findings

- Split-mode records with no studio identity lack a review marker. They remain under the feed label and do not receive a guessed studio. Deferred under the review skill's minor-finding rule; add a clear warning state in a later UI task.
- The generic metadata review tooltip says durations disagree even for other metadata problems. Deferred as a minor UI copy issue; correct it when the review states are next edited.

## Fresh verification evidence

- `node --test test/composite-review.test.ts test/bang-originals.test.ts test/sync.test.ts`: 53/53 pass.
- `npm run typecheck`, `npm run lint`, `npm run format:check`: pass.
- `npm test`: 578/578 pass, 0 failures.
- `git diff --check`: pass.
- Started locally with boot sync disabled and a temporary database. A populated Chromium check showed the Maximo alias, 600–601 second range, and both field sources in the dashboard and API; no browser errors. Process stopped.
- No live feeds, hosting, deployment, push, or pull request were used.

## Completion

Tasks 1–8: complete.
Review fix pass: complete.
Pending: human's branch integration choice.
