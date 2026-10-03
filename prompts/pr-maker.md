# PR maker

Read `AGENTS.md` first. Using `gh` in `bifanaboy/liszt`, inspect open issues.
Exclude issues labelled `needs-intel`, issues with an open pull request already
implementing them, issues with unresolved owner decisions, and parent issues
with unfinished child issues or issues blocked by another open issue. Do not
work on more than one issue per run.

Choose an eligible issue in this order: `urgent` before `not urgent`, `major`
before `minor` within the same urgency, then oldest issue first. If a required
label is missing or no issue is eligible, report why and do nothing.

Read the issue, relevant comments and relationships, linked issues, and
affected code. Follow `AGENTS.md`; ask for owner input when a real decision is
needed instead of guessing. Check the working tree, fetch current `origin/main`,
review relevant open pull requests, and make a new branch from current
`origin/main`. Keep the change as small as the issue requires. Do not merge or
force-push.

Run the repository checks: `npm test`, `npm run typecheck`, `npm run lint`, and
`npm run format:check`. Fix issues caused by your change and rerun the checks.
Commit the change and open one non-draft pull request that references the issue.

At the end, link the issue and pull request, summarize the change, and report
each check's result. If blocked, explain the specific blocker and do not open a
pull request for incomplete work.
