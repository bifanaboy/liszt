# Composite release ingestion and repair

## Plain-language goal

Make releases reported by different feeds appear once, under the intended
studio name, with a record of which feed supplied each field. Each feed may use
a different domain, API, and response format. The app should keep those
provider-specific details at the edges and apply the same release and studio
rules to every feed.

This repair also addresses the audited adapter, configuration, command-line,
type-check, lint, formatting, naming, and documentation problems that interfere
with this behavior or make it hard to maintain.

## Confirmed behavior

- A coding agent is given one or more feed URLs. Supporting a new API means
  adding a provider adapter that knows how to fetch, paginate, validate, and
  translate that provider's records. The running app does not guess how an
  arbitrary URL works.
- A feed assigns scenes to their identified studios by default. A feed may
  instead declare one umbrella studio identity, such as `DreddXXX`, for every
  scene it emits.
- The app stores and displays one canonical release when observations are
  verified to describe the same release. It retains every contributing
  provider observation and the source of each selected field.
- Source failure, missing fields, or an empty response from one provider must
  not erase good information supplied by another provider. Failed polls retain
  last-good observations.
- Preserve provider-reported durations individually. For positive durations
  that disagree, the canonical release carries the inclusive minimum-to-maximum
  range. A playback candidate may pass the duration gate inside that range,
  with the existing ±1-second tolerance at either edge. Existing date and
  identity requirements remain in force. A range wider than a separately
  established safe limit is marked for review and cannot automatically link.
- Variable names in changed code use one descriptive word where practical;
  do not use unclear single-letter or generic names to satisfy this preference.

## Shared architecture

1. A feed declaration identifies the provider adapter, feed URL, and studio
   policy (`split` by default, or `umbrella` with a studio identity).
2. The provider adapter converts API-specific responses into provider
   observations with stable provider IDs, studio identity, exact field values,
   and provenance. Umbrella assignment changes the displayed studio identity
   but retains the provider's studio key so later policy edits do not re-key
   provider-native records.
3. A shared identity and merge step groups observations only when there is
   reliable evidence that they describe the same release. A normalized release
   URL or verified shared provider identity is strong evidence. A title alone,
   or a title shared across unrelated hosts, is not sufficient. Maximo is the
   documented exception: observations from distinct Maximo providers can group
   by normalized title only when every record has a positive duration. The
   resulting duration range exposes disagreement and blocks automatic linking
   when it is wider than one second. Ambiguous observations remain separate
   and can be reviewed.
4. The merge step selects canonical fields, records field-level provenance,
   combines duration observations into a range, and persists one canonical
   release plus its provider observations.
5. Matching, read-model output, and dashboard display consume the same
   canonical release. They must not implement separate deduplication rules.

The stored provider observations are needed so independent polling and failures
do not overwrite one another. A migration must preserve existing release IDs
where possible, along with playback links, dead-link history, and resolver
state.

## Studio-specific requirements

### Maximo Garcia

The composite input set recorded in open issue #115 is the public Fansly page,
TPDB sites `fuckingpornstars`, `maximogarcia`, and `manyvidsmaximogarcia`, plus
the existing ManyVids store `1003095958`. They should map to one Maximo identity.
Titles containing the requested `trans` marker are excluded. When duplicate
observations have matching durations, choose the one with the oldest release
date, then configured provider priority and stable provider ID for ties. This
uses the ordering field the user confirmed.

### Dredd

Map the declared TPDB site IDs `50864`, `39697`, and `81939` to one Dredd
identity. The repository default must retain the `DreddXXX` alias and all three
IDs. The IDs appear in prior merged work but are absent from the current
`studio-links.default.json`.

### Bang! Originals

The current adapter is a placeholder and cannot emit releases. A live capture of `https://www.bang.com/videos?by=date.desc` shows a `SearchResultsPage` JSON-LD listing with video URLs and pagination. Each linked video page has `VideoObject` JSON-LD with name, thumbnail, datePublished, duration, and production company. Require `Bang! Originals`, allow only `www.bang.com` links, and stop pagination at the requested window boundary. The observed listing exposes three pages of up to 44 records.

## Release identity and duration safety

Normalize the same release URL across harmless differences such as host casing,
fragments, trailing slashes, and verified punctuation variants in a path. Do
not merge cross-host mirrors by title alone. Issue #130 specifically describes
same-page punctuation variants as duplicates, while treating different-host
mirror candidates as ambiguous without shared ID evidence. Maximo records are
grouped by normalized title only inside the declared Maximo studio and only
when every contributing provider supplies a positive duration; duration
disagreements remain visible as ranges and wide ranges require review.

The duration range is calculated from positive provider observations, not from
an average. A candidate passes duration eligibility when its duration is
within the inclusive range plus the existing one-second edge tolerance. If all
providers agree, this preserves the current ±1-second behavior. Ranges wider
than one second require review and cannot automatically link.

## Audited repairs and maintenance scope

- Pass the configured studio declarations into the source registry and make
  their aliases and multiple TPDB site IDs effective.
- Remove or connect Maximo options that are currently read but unused.
- Let the studio-link command process a Traxxx-only declaration without
  requiring a TPDB API key; require the key only when resolving a TPDB URL.
- Resolve the current type-check failures in app wiring and stale TPDB test
  shapes, the unused-variable lint failures, and the formatting failures.
- Replace ambiguous names in changed ingestion and merge code with one-word
  descriptive names.
- Trim historical narration from source comments touched by the repair after
  behavior is covered by tests. Keep comments that explain current contracts,
  safety boundaries, or non-obvious decisions.
- Update the README to explain supported setup and the shared architecture
  without repeating agent-only rules or extensive implementation history.
  Review completed planning/scratch documents for archival or removal; retain
  reference material that still supports active work.

## Failure behavior

- Each provider fails independently. A failed provider records its error and
  keeps its last-good observations; other providers continue.
- Invalid or incomplete provider data is rejected at the adapter boundary and
  cannot erase canonical fields.
- Unknown studio identity in split mode is reported for review, not silently
  filed under an unrelated studio.
- Ambiguous release identity does not auto-merge.
- A duration range above the approved width limit receives a review state and
  cannot produce an automatic playback link.
- Do not change hosting, deployment settings, or live service configuration as
  part of this repository repair.

## Acceptance criteria

- Two verified provider observations for one release produce one canonical
  release with provenance for both and field provenance for each selected
  value.
- Separate mode creates distinct studio identities for records that identify
  different studios; umbrella mode assigns all feed records to the declared
  identity.
- A provider outage or missing field does not erase another provider's last
  good value or playback history.
- Matching accepts candidates within the derived duration range and one-second
  edge tolerance, while retaining date and identity gates. A too-wide range
  cannot automatically link.
- Maximo's declared feeds map to one studio and apply its exclusion rule;
  Dredd's three site IDs map to one studio.
- Bang emits real, window-filtered records only after its actual feed and
  response format have been verified. Until then, report this part as blocked
  on the missing sample rather than claiming completion.
- Typecheck, lint, formatting, and the full test suite pass after implementation.
- Documentation matches verified behavior and removes redundant material
  without deleting active guidance.

## Open decisions and evidence gaps

1. **Maximo “earliest video” wording:** issue #115 does not identify an ordering field. The reversible implementation ruling uses the earliest provider release date; configured provider priority and stable provider ID break ties.
2. **Conflicting non-duration fields:** preserve observations, select by configured per-field provider priority, and persist the winning source.
3. **Maximum duration spread:** no production corpus is available in this checkout. Use a conservative 1-second inclusive range-width ceiling for automatic matching and hold wider ranges for review; revisit after composite observations accumulate.

## Related repository work

The design incorporates the active concerns in issues #115 (Maximo composite),
#130 (duplicate identity), and #144 (Bang parser), plus the audited wiring and
quality-gate failures. Issue #141 reports a startup syntax error that is no
longer present in the current tree; its broader request for boot and check
verification remains relevant. There are no open pull requests. Dredd issue
#116 and its earlier multi-site implementation provide the three intended TPDB
site IDs noted above.
