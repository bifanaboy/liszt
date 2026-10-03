# Studio-first release metadata

## Problem and goal

Traxxx currently discovers releases and supplies all catalogue metadata. A
release without a Traxxx running time stays ineligible for video matching even
when its studio's own page publishes that time. Use Traxxx to discover the
release, then use the studio's Stash CommunityScrapers detail scraper as the
preferred metadata source. Keep Traxxx values as field-by-field fallback.

The first scope is every release from the current Traxxx lanes whose original
studio URL maps to a Stash detail scraper. Releases without a usable studio URL
or an applicable scraper continue to use Traxxx. Studio catalogue discovery
remains Traxxx's job; this change does not walk studio listing pages.

## Data flow

1. The existing Traxxx adapter fetches and identifies releases as it does now.
2. Before catalogue upsert and video matching, the sync fetches an eligible
   release's own page through a host-specific TypeScript scraper profile based
   on the corresponding Stash CommunityScrapers scene-detail definition. Liszt
   does not run Stash or copy its runtime into the application.
3. A successful detail response may supply title, release date, performers,
   duration, thumbnail, and tags. For each field, verified studio data wins;
   if the studio page omits that field, keep a value from Traxxx or from an
   earlier studio scrape. Values and field provenance are merged under the
   existing Traxxx scene key, preserving links and dead-link history.
4. The existing matching pipeline receives the merged scene. Its date and
   duration checks, including the ±1-second duration tolerance, are unchanged.

The exact Traxxx release URL is the identity evidence for a detail lookup. Do
not search by similar title or copy data from another release. Only fetch
HTTPS hosts explicitly covered by an applicable scraper profile; validate
redirects against the same allowed hosts. A page that is blocked, unavailable,
unparseable, or missing a field leaves the existing Traxxx value in place and
does not fail the whole source refresh.

## Boundaries and request cost

- Existing direct studio sources remain unchanged; the new enrichment is for
  Traxxx-discovered scenes with an original release URL.
- Use the sync's existing concurrency and timeout controls. Persist each
  scene's last studio-detail attempt so a failed or incomplete page is retried
  no more than once per 24 hours. Skip a scene after all supported fields have
  studio provenance. Limit studio-detail work to 50 scenes per sync, choosing
  scenes with no prior attempt first, then the oldest due attempt. Do not add a
  new dependency or a configurable scraper framework.
- Preserve successful studio fields across later Traxxx refreshes that omit
  them. A source error must retain the last good scene and all playback links.
- Unsupported studios or pages that cannot be parsed continue with Traxxx
  metadata and existing eligibility rules. Missing duration still means no
  video resolution.
- Keep field provenance so the catalogue can identify studio-supplied values.

## Implementation shape

Add a small studio-detail registry built from the current Stash scraper
definitions and call it during the existing source-to-store step in
`src/pipeline/sync.ts`. Keep per-site parsing beside the registry in
`src/sources/`; use the existing fetcher and concurrency helpers. Persist the
last-attempt time for each scene, then merge the result into `RawScene` before
`normaliseScene`, preserving prior studio values when a refresh has no
replacement. No change to source discovery, tube search, matching policy, or
deployment configuration.

The host profile lists which fields that site's Stash definition can supply.
Only fields listed for that profile count as supported when deciding that a
scene is complete. Inventory the studio hosts emitted by all current Traxxx
lanes and include every host with a matching Stash detail scraper. A host
without a matching scraper continues to use Traxxx.

## Approaches considered

- **Scrape the studio's release list first.** This would find releases Traxxx
  has not indexed, but requires a different listing and paging rule for each
  studio. Issue 48's research notes that the Stash definitions generally do
  not include those rules. This is outside the agreed scope.
- **Use Traxxx alone and scrape only missing fields.** This is smaller, but
  keeps Traxxx as the metadata authority even when the studio page has a
  different or fuller value. It does not match the requested behavior.
- **Use Traxxx for discovery, then the studio detail page for metadata.** This
  follows the agreed order, reuses the stable Traxxx scene identity, and avoids
  inventing listing walkers. This is the selected approach.

## Acceptance

- Every current Traxxx studio host with a matching Stash detail scraper has a
  corresponding profile; unmatched hosts remain on Traxxx metadata.
- The reported Tushy release can obtain its duration from its own scene detail
  response when the site's detail endpoint is available; the value is recorded
  as studio-sourced and reaches matching.
- A subsequent Traxxx refresh that omits duration retains the studio value and
  its field provenance.
- A conflicting field from the exact studio release uses the studio value;
  fields missing from the page keep their Traxxx values.
- An unavailable page, redirect to an unapproved host, malformed response, or
  wrong-scene response does not erase metadata, create a duplicate, or fail the
  refresh.
- Scenes with no usable duration remain unlinked. Matching's date window and
  ±1-second tolerance are unchanged.
- Studio scrape requests are limited by the existing timeout and concurrency
  controls, no more than 50 detail requests per sync, and no more than one
  attempt per scene per 24 hours.

## Evidence and limits

Issue 48 provides the reported missing-duration example and specifies studio
metadata as primary with Traxxx fallback. Its discussion records partial trials
and notes that Stash CommunityScrapers generally expose single-scene detail
lookups rather than studio release listings. The Vixen scraper definition
includes a release detail query with `runLength`, but the studio endpoint has
not been verified from this workspace. The first implementation must validate
its fixtures and fail safely when a studio endpoint is unavailable. Broader
coverage is limited to definitions actually mapped and handled in this
repository; an unmapped scraper is not silently treated as supported.
