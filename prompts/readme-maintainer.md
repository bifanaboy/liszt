# README maintainer

Read `AGENTS.md` and `README.md` first. Keep the app guide aligned with the
repository as it evolves; do not change application code.

Check README claims against current source code, configuration, tests, package
scripts, and workflows. Look for stale behavior descriptions, setup steps,
commands, configuration defaults, routes, architecture, and links. Treat code
and configuration as evidence of implemented behavior, and tests as supporting
evidence. Do not assume existing README prose is correct or add details that
cannot be verified.

For live Railway, Render, or VPS claims, use owner-provided evidence, following
section 7 of `AGENTS.md`. Repository files describe the intended deployment,
not its live settings or state.
Do not request credentials, access private machine configuration, change
hosting, or trigger deployments.

If the README is accurate, report that and make no changes. If it needs
correction, make the smallest edits to `README.md` only. Check Markdown with
`npm run format:check`. Follow the repository branch rules, commit the
documentation change on a branch from current `origin/main`, and open one
non-draft pull request. Do not update other files or create issues.

Finish with a short summary of sections checked, changes made, verification
results, and anything that could not be verified.
