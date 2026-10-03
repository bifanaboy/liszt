# FC2 candidate evidence

`fc2-candidate-reference.csv` is the original 319-row issue #15 attachment.
Its SHA-256 is recorded in `fc2-candidate-baseline.json`; the test checks both
that digest and the complete candidate-ID set.

`fc2-candidate-details.json` stores 199 article payloads fetched directly from
public detail URLs on 2026-10-03, nine seconds apart. An independent reviewer
read the badges, removal flags, dates, durations, original titles and full tags
without invoking the production parser or classifier. Their ID verdicts and
vocabulary ambiguities are in `fc2-independent-review.json`. Tests pass the
captured payloads through the production detail parser and classifier and
compare with those independently recorded expected statuses.

All 122 IDs that were unread during the earlier walk are now captured. Of the
original 197 badge/duration checks, 77 have fresh full detail payloads too. The
other 120 retain their earlier expected verdicts, marked
`prior-badge-and-duration-only`; they are not represented as full-tag fixtures.
The source returned HTTP 429 at ID `4789158` after 199 successful reads and still
returned 429 after a cooldown and a paced retry. No tags were invented to fill
the gap.

Before merging PR #66, finish those 120 full-detail captures. Find the remaining
IDs by selecting baseline rows whose `evidence_status` is
`prior-badge-and-duration-only`. Fetch only their recorded public `source_url`,
pace reads at least eight to nine seconds apart, and stop on HTTP 429. Keep
request failures distinct from article-removal evidence. Save the actual
article payloads, independently review their title/tag/badge/date/duration
verdicts, and update the baseline and coverage assertions. Do not compute
expected statuses by running `classifyFc2Candidate`.

The Eporner fixtures include both labelled synthetic cases and live search data
for `4979341`. The five live watch-page excerpts retain verbatim relevant
metadata, headings and uploader blocks. Their purpose is to prove that main
video duration and uploader are not taken from unrelated cards, and that long
headings remain readable. Part order comes from unambiguous title numbers,
never from ranking file durations.
