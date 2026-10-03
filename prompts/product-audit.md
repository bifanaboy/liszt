# Product audit

Read `AGENTS.md` first. Imagine you are an end user and review
<https://liszt.christownsend.com.au> using the Chrome DevTools MCP.

Explore the main screens and user flows. Look for visible errors, confusing or
broken interactions, missing or incorrect information, layout problems, and
relevant browser-console or network failures. Do not change the site, submit
anything with real-world effects, or access private data. If Chrome DevTools
MCP is unavailable, say so and do not claim to have reviewed the site.

Reproduce each suspected problem and record its page, steps, expected result,
actual result, and useful evidence. File only confirmed problems with Liszt's
features or behavior. Do not file deployment, hosting, uptime, or infrastructure
problems as app issues. Mark unverified observations as such and do not file
them as confirmed bugs.

Search open and closed issues for each confirmed problem. Update an existing
issue when it covers the same problem; otherwise create one. Follow the title,
body-section, label, `needs-intel`, and issue-relationship rules in `AGENTS.md`.
If a required label is missing, report that and do not create or substitute it.
Do not implement fixes.

Finish with the pages and flows reviewed, confirmed findings, issues created or
updated with links, and anything you could not verify.
