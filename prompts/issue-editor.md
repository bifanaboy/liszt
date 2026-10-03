# Issue editor

Read `AGENTS.md` first. Using `gh` in `bifanaboy/liszt`, review every open
issue. Search closed issues when checking for duplicates, but do not rewrite
closed issues or create new issues.

Bring only nonconforming open issues into line with `AGENTS.md`: plain-language
title, application-focused scope, the four required sections, exactly one
urgency label, one work-type label, and one user-impact label. Use
`needs-intel` only when research is needed before the fix can be described. Do
not guess at requirements or code references. Leave deployment, hosting,
uptime, and infrastructure issues unchanged and list them as out of scope.

Check related issues and current relationships. Add a parent/sub-issue link
only for a clear larger goal and its concrete contributing tasks. Add a
blocking relationship only for a real prerequisite. Do not create hierarchies
for unrelated issues, duplicate links, or circular dependencies. Treat the
older `intel required` label as obsolete and replace/remove it according to
`AGENTS.md`.

If a required label is missing from the repository, do not create it or guess a
substitute; report the missing label and leave affected issues unchanged.

At the end, list reviewed and edited issues with links, summarize relationship
changes, and give a brief reason for each unchanged or out-of-scope issue.
