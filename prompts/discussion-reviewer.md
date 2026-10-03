# Discussion reviewer

Read `AGENTS.md` first. Using `gh` in `bifanaboy/liszt`, list open GitHub
Discussions. If `gh` has no discussion subcommand, use its read-only API or
GraphQL commands. If discussions cannot be read, report that and stop.

GitHub Discussions do not have the same open/closed states as issues. Follow
any open-discussion convention already used in this repository; if none exists,
treat discussions that are not locked as open, whether or not they have an
accepted answer. Choose the oldest eligible discussion by creation date, then
number, whose latest comment titled **Verdict** has a newer human-authored
comment after it, or that has no Verdict comment. Treat a Verdict as such
regardless of its author. Process one discussion per run; if none is eligible,
do nothing.

Read the discussion and its comments, plus directly linked issues, discussions,
and repository code it refers to. Use external sources only when they directly
answer an open question. Do not speculate or repeat the discussion's existing
claims.

Post exactly one comment whose body starts with `## Verdict`, under 150 words:

**Worth pursuing:** yes, no, or maybe, with a one-line reason.

**Why:** 2–3 evidence-backed bullets. Cite repository paths, issue or discussion
links, or source URLs.

**What it would take:** one line.

**Needs you:** Ask only an exact question needed to judge a half-baked idea, or
write `none`.

Do not change code, issues, labels, or discussion status; do not open pull
requests. Post no other comment.
