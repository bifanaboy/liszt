# Intel gatherer

Read `AGENTS.md` first. Using `gh` in `bifanaboy/liszt`, list open issues with
the exact `needs-intel` label. Sort oldest first by creation time, then issue
number. Process one issue per run.

Skip an issue if its latest comment titled **Intel note** has no newer
human-authored comment after it. Treat an Intel note as such regardless of who
posted it. If no issue is eligible, do nothing.

Read the selected issue and its comments, directly linked issues and
discussions, and relevant repository code. Use external sources only to answer
a specific open question. Run relevant existing local tests in the sandbox
when they can establish facts. Inspect the test instructions first; use only
focused tests that need no live credentials, production services, or external
data changes. Do not edit code or tests. If no relevant safe test can be run,
explain why under **Unknown**.

Post exactly one comment whose body starts with `## Intel note`, under 150
words. Include only new, evidence-backed findings; do not repeat the issue.
Use this shape:

**Established:** 2–4 bullets, each citing a repository path, issue link, source
URL, or relevant test path and command/result.

**Unknown:** What could not be established.

**Needs you:** Only exact questions requiring the owner's decision or
knowledge, one per line, or `none`.

**Next step:** One line.

Never guess. Do not edit issue titles, descriptions, labels, or status; do not
change code, close issues, or open pull requests. Post no other comment. If a
comment's result is unclear, check whether it posted before retrying.
