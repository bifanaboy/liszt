# Scheduled Kilo Code prompts

These files are the copyable instructions for the recurring Kilo Code tasks in
the Liszt repository. Each task should run from this repository, read
[`AGENTS.md`](../AGENTS.md), and follow the relevant prompt below. Shared issue,
documentation, security, and repository rules live in `AGENTS.md` so they do
not drift between schedules.

| Prompt | Job | Changes it may make |
| --- | --- | --- |
| [Issue editor](issue-editor.md) | Bring open issues into line with repository issue rules. | Edit open issue titles, descriptions, labels, and relationships. |
| [Product audit](product-audit.md) | Review the live app as an end user and file confirmed app issues. | Read the site; create or update issues. |
| [Discussion reviewer](discussion-reviewer.md) | Give a short evidence-based verdict on one open discussion. | Post one discussion comment. |
| [Intel gatherer](intel-gatherer.md) | Research one eligible issue that needs more information. | Post one issue comment. |
| [PR maker](pr-maker.md) | Implement one ready, high-priority issue and open a pull request. | Change code on a branch and open one pull request. |
| [README maintainer](readme-maintainer.md) | Keep the app guide accurate as the repository changes. | Edit `README.md` on a branch and open one pull request. |

Do not combine the schedules. Each prompt processes at most one item per run,
unless its instructions explicitly say to review the full open issue backlog.
