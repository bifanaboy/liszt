/**
 * Cross-lane release identity.
 *
 * Two lanes can describe one release. A Traxxx studio lane and the TPDB lane
 * both cover the same studio, and they emit the SAME release page URL - the
 * studio's own page, reached from two directions. Their scene ids differ
 * (`<source-id>:<scene-id>` is per-source), so without this the same release is
 * stored twice and appears twice in the catalogue.
 *
 * The release URL is the identity, not the title. Verified live: the paired rows
 * carry byte-identical URLs like
 * `https://darkkotv.com/scenes/lana-analise-gaping-interracial-anal_vids.html`,
 * while titles and dates vary in case and punctuation between the two databases.
 * A title+date key would therefore miss real duplicates; the URL is the one
 * field both sides agree on because it points at the thing itself.
 *
 * Why first-wins rather than merging: one row per release is what every
 * downstream stage already assumes. The read model, the resolver and the
 * catalogue counters all read by scene id, and a second row for a release the
 * first row already covers does not add information - it adds a second
 * resolution attempt and a second entry in the catalogue. Which lane wins is
 * not arbitrary: lane order is stable and TPDB is fetched last, so a Traxxx
 * lane keeps the row it has always had, and TPDB only contributes releases no
 * other lane saw. TPDB's real value here is COVERAGE - studios with no Traxxx
 * lane at all - not duplication.
 */
import type { RawScene } from "../sources/types.ts";

/**
 * The release identity, or `undefined` when the record has no usable URL.
 *
 * A record without a release URL cannot be identified this way. It is kept
 * rather than dropped: an unidentified record cannot be proven to be a
 * duplicate, and silently discarding releases would be far worse than showing
 * one twice.
 */
export function releaseIdentity(raw: Pick<RawScene, "releaseUrl">): string | undefined {
  const url = raw.releaseUrl?.trim();
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    // http vs https, a trailing slash, and an empty fragment are all the same
    // page. Host case is not: keep the path and query, which are what identify
    // the release, and normalise only what cannot change the page.
    parsed.hash = "";
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.host.toLowerCase()}${path}${parsed.search}`.toLowerCase();
  } catch {
    // Not a parseable URL. Use it verbatim rather than dropping the record:
    // two identical unparseable strings are still evidence of one release.
    return url.toLowerCase();
  }
}
