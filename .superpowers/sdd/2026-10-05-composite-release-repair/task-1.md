# Task 1 Brief: Source and merge decisions

## Findings

- Bang's live `https://www.bang.com/videos?by=date.desc` response is an HTML listing with a `SearchResultsPage` JSON-LD block containing up to 44 item URLs and pagination links (`page=2`, `page=3`). A listed video detail page has a `VideoObject` JSON-LD with `name`, `thumbnailUrl`, `datePublished`, `duration`, and `productionCompany.name` (`Bang! Originals`). The page also has `video:release_date`. Captured 2026-10-05. The adapter must follow listing pagination only as needed for the requested window; it should reject unexpected host URLs and validate the production company before emitting.
- Bang current source evidence is real; the live sample scene was `https://www.bang.com/video/aqL9aWnMO0CDDQet/amiee-cambridge-s-wild-four-cock-gangbang-adventure`, dated 2026-10-05, duration `PT44M02S`, company `Bang! Originals`.
- Issue #115 explicitly lists Fansly and TPDB URLs/IDs, excludes titles containing ` trans `, and says choose the “earliest video” when durations match. It does not name a date/ordering field. For implementation, interpret “earliest video” as the record with the earliest provider release date; ties are resolved by configured deterministic provider priority. Preserve all provider observations so this interpretation can be revised without data loss.
- No production observation database is available in this checkout to measure Maximo duration spreads. Conservative automatic range width is set to 1 second (inclusive), beyond which a release is held for review. This preserves the user's requested ±1 second at each range edge while minimizing the added matching envelope until a real composite corpus can be measured.
- Non-duration conflicts: preserve all observations; choose field values by per-field configured provider priority, then earliest provider release date for Maximo duplicate ranking, then stable provider ID. Persist selected field provenance.
- Issue #130 confirms apostrophe omission in path is safe for same-host same-id page variants, while the cross-host mirror example is explicitly ambiguous and must remain separate absent shared identity.

## Required design update

Record the Bang capture, earliest-date interpretation, 1-second maximum automatic duration spread, and deterministic conflict selection in the approved design spec. No unresolved parser-shape blocker remains. Earliest-date interpretation is an explicit, reversible ruling based on the only available date field, not a claim that the issue author defined it that way.

## Task completion check
- [x] Evidence and rulings captured in the design spec.
- [x] No parser schema invented; based on live structured data.
- [x] The one behavior interpretation requiring future confirmation is identified as reversible and preserved in provenance.
