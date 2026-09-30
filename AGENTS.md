# Agent Rules — liszt

Read these before touching anything in this repo. They apply to every agent and
every session.

---

## 1. Render: the only deployment target

This app lives on Render. There is no VPS, no Docker, no Cloudflare Tunnel. If a
suggestion involves any of those, it is wrong for this project.

Every value in this table was read from Render's API on 2026-09-30. If one of
these ever disagrees with the dashboard, the dashboard is right and this file is
wrong — fix it here.

| Thing            | Value                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| Render workspace | `Liszt`, id `tea-daqlqsrtqb8s73b3qcu0`                                           |
| Service name     | `liszt` — slug `liszt-h2cl`, id `srv-daugkumgekts73ecsgp0`                       |
| Live URL         | `https://liszt-h2cl.onrender.com`                                                |
| Region           | `singapore`                                                                      |
| Service type     | `web` (Node)                                                                     |
| Plan (live)      | `free`                                                                           |
| Build / start    | `yarn` / `npm run start`                                                         |
| Health check     | none configured on Render; the app serves `GET /health`                          |
| Disk             | **none attached** — see "The database does not survive an instance change" below |
| Auto-deploy      | Only after CI checks pass (`autoDeployTrigger: checksPass`)                      |
| Source repo      | `https://github.com/bifanaboy/liszt`                                             |
| Service id       | read it from the table above, never guess it                                     |

### `https://liszt.onrender.com` is NOT this app

It is a different, abandoned service serving a stale website last touched in
April 2025. It answers `/health` with `200` and an HTML page, so **a status-code
check against that host passes forever while testing nothing.** If a URL appears
in a script, a doc, or a plan, it must be `liszt-h2cl`. The honest check reads
the body, not the code:

```
curl -s https://liszt-h2cl.onrender.com/health
```

Success is exactly `{"status":"ok"}`. If you get HTML, you are pointed at the
wrong host.

### `render.yaml` does not describe the live service

The blueprint and the running service disagree on almost everything. The service
was created in the Render dashboard; it was not created or synced from
`render.yaml`.

| Setting       | `render.yaml`           | Live service    |
| ------------- | ----------------------- | --------------- |
| Region        | `oregon`                | `singapore`     |
| Plan          | `0.5c-512mb` (paid)     | `free`          |
| Disk          | `liszt-data` at `/data` | none            |
| Build command | `npm ci --omit=dev`     | `yarn`          |
| Start command | `node src/app.ts`       | `npm run start` |
| Health check  | `/health`               | not configured  |

**Do not "sync" the blueprint to fix this.** A sync would attempt to move the
service from Singapore to Oregon, replace the free plan with a paid one, and
attach a paid disk — all of which section 2 forbids, and a region change means a
full restart with a cold cache. Treat reconciling the two as its own task, with
its own approval, after the cost is spelled out.

### The database does not survive an instance change

No disk is attached, and a free plan cannot hold one, so the SQLite file lives on
the instance's own filesystem.

Measured on 2026-09-30: the service answered `total: 0` scenes at 18:38:07, then
the logs show a **different instance** starting a full sync at 18:38:40
(`…-rg2ss` before, `…-dgwn5` after), and by 18:41 `/api/scenes` reported 121
scenes and the same 46 links again. The store was genuinely empty in between —
`buildReadModel` derives `stats.total` from the rows themselves and does not
blank it while a sync runs.

The likely cause is the free plan's idle spin-down: a free instance is destroyed
after 15 minutes without traffic, and a new one starts with an empty
filesystem. A deploy does the same thing. Either way the practical rule is the
same:

**Never measure from the live URL unless you have just triggered a sync, and
treat any local database as throwaway.** A measurement taken after an idle gap
may be reading a store that has not been rebuilt yet, and a sync takes a couple
of minutes — check `latestRun` and `refreshing` before trusting a number, and
never read `total: 0` as "the app is broken".

### Monitoring without a Render key

Two channels work and need no secret:

- **Live health**: the `curl` above. Success is `{"status":"ok"}`; any HTML means
  the wrong host.
- **Deploy history**: Render publishes every deploy to the GitHub Deployments
  API for `bifanaboy/liszt` under environment `liszt`. Read it with
  `gh api repos/bifanaboy/liszt/deployments` and then
  `gh api repos/bifanaboy/liszt/deployments/<id>/statuses`. States:
  `in_progress`, `success`, `failure`, and `inactive` (Render marks a deploy
  `inactive` once a newer deploy supersedes it, which is not an error).

The Render MCP server is authenticated and working — it reads workspaces,
services, deploys, events, logs, and metrics. Use it rather than asking the user
for credentials. It cannot write: deploy triggering, environment variables, and
database queries stay denied.

---

## 2. Key security — treat every secret as disposable

- **Never commit a secret.** No API keys, tokens, passwords, connection strings,
  or `.env` files with real values in anything git tracks. `.env.example` holds
  placeholder names only.
- **Never write a secret into this repo**, including in comments, plans, or
  documentation.
- Local secrets live only in the user's own machine config (for example
  `~/.config/kilo/kilo.jsonc`), which is outside this repository.
- **Never echo a secret back** in chat, in command output, in logs, or in a
  commit message. Refer to it as "the key" or "the token", never by value.
- **Never send a secret to a third party** — no webhooks, no external APIs, no
  telemetry, no issue or PR bodies, no AI services other than the configured
  provider.
- **If a secret is ever pasted into chat, logged, or committed, treat it as
  burned.** Say so immediately, then revoke it in the Render dashboard and issue
  a replacement. Do not wait to be asked. A key pasted into a conversation is
  public to anything that reads the transcript.
- **No paid anything.** Every service here is free and no credit card is on
  file. Never add a service, plan, addon, or upgrade that would start charging.
  If a task seems to require one, stop and explain the cost in plain words first.
- **Least privilege.** The Render MCP permissions in `~/.config/kilo/kilo.jsonc`
  deny deploy triggering, environment variable writes, and database queries. Keep
  it that way; monitoring is the job.

---

## 3. How to talk to the user

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
  yourself. Ask only for things genuinely requiring a human: credentials,
  account access, and real decisions.
