# Agent Rules — liszt

Read these before editing this public repository.

## 1. Scope

Coding agents have repository read/write access only. They do not have private
Render access, credentials, or authority to manage hosting or accounts.
Instructions here must stay within that scope.

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

