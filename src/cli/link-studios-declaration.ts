/**
 * Building a studio declaration from what the operator pasted.
 *
 * Separated from `link-studios.ts` so it can be tested without a live API. The
 * rule it exists to enforce: a TPDB search address carries its tags in the query
 * string, and those tags decide what the lane collects. Dropping them produced a
 * declaration that looked correct and ingested an entire site instead of the
 * tag-scoped subset the operator asked for.
 */
import {
  canonicalStudioId,
  cleanStudioName,
  type ResolvedTpdbSite,
  type StudioLink,
  type TpdbLookup,
} from "../sources/studio-identity.ts";

/** The Traxxx side, when one was pasted. Mirrors `TraxxxLaneSpec`'s used fields. */
export interface DeclarationLane {
  kind: "network" | "channel";
  slug: string;
  tags: readonly string[];
  url: string;
}

export interface DeclarationInput {
  /** The parsed TPDB side. Omitted for a Traxxx-only declaration. */
  lookup?: TpdbLookup;
  /** What TPDB resolved the lookup to, or undefined when it did not resolve. */
  resolved?: ResolvedTpdbSite;
  /** The parsed Traxxx lane, when a Traxxx address was pasted. */
  lane?: DeclarationLane;
  /** The display name to record. */
  studioName: string;
}

/**
 * The studio key for a TPDB-only lane.
 *
 * `canonicalStudioId` folds tags into the key for the Traxxx branch only, so on
 * this side both the tags and the key were invisible to each other: `site_id=988`
 * and `site_id=988&tags[70]=Anal` both produced `tpdb-bang`. `auditStudioLinks`
 * then rejected a file holding both as a duplicate, and `link-studios --write`
 * overwrote one with the other - so the tagged and untagged lanes, which are
 * genuinely different lanes, could not coexist. The tag scope belongs in the key
 * here for the same reason it does on the Traxxx side.
 */
function tpdbLaneId(resolved: ResolvedTpdbSite, tags: readonly string[]): string {
  const base = canonicalStudioId({ tpdb: resolved });
  const scope = tags.map((tag) => cleanStudioName(tag).replace(/\s+/g, "-"));
  return scope.length ? `${base}-${scope.join("-")}` : base;
}

/**
 * The lookup the resolver is given, with the operator's display name applied.
 *
 * Every field the resolver reads is carried across. Dropping `exactSiteId` here
 * made an exact `site_id` fall back to a name match, so a stale or simply
 * different `--name` reported an id that is exact by construction as UNRESOLVED.
 */
export function lookupForResolver(lookup: TpdbLookup, displayName?: string): TpdbLookup {
  return {
    candidates: lookup.candidates,
    ...(lookup.uuid ? { uuid: lookup.uuid } : {}),
    ...(lookup.exactSiteId !== undefined ? { exactSiteId: lookup.exactSiteId } : {}),
    // The display name is what verifies a loose slug match. Without one the
    // lookup can only be exact, so a name is required for a name-only URL.
    ...((displayName ?? lookup.name) ? { name: displayName ?? lookup.name } : {}),
  };
}

export function buildDeclaration(input: DeclarationInput): StudioLink {
  const { lookup, resolved, lane, studioName } = input;
  const traxxx = lane ? { kind: lane.kind, slug: lane.slug, url: lane.url } : undefined;
  // A Traxxx lane's OWN tag list wins whenever a lane exists - including when it
  // is empty. A tag list invented from the TPDB side would produce a lane id the
  // configured lane does not use (`network-bang-Anal` against `network-bang`),
  // and the studio's releases would file under two different keys. The TPDB
  // search tags apply only to a TPDB-only declaration.
  const tags = lane ? [...lane.tags] : lookup?.tags ? [...lookup.tags] : [];
  const tagsField = tags.length ? { tags } : {};
  return {
    studioId:
      !traxxx && resolved
        ? tpdbLaneId(resolved, tags)
        : canonicalStudioId({
            ...(traxxx ? { traxxx } : {}),
            ...(tags.length ? { tags } : {}),
            ...(resolved ? { tpdb: resolved } : {}),
          }),
    studio: studioName,
    ...tagsField,
    ...(traxxx ? { traxxx } : {}),
    ...(resolved
      ? {
          tpdb: {
            siteId: resolved.siteId,
            ...(resolved.uuid ? { uuid: resolved.uuid } : {}),
            name: resolved.name,
            ...(resolved.shortName ? { shortName: resolved.shortName } : {}),
            ...(resolved.url ? { url: resolved.url } : {}),
            ...(resolved.networkId ? { networkId: resolved.networkId } : {}),
          },
        }
      : {}),
  };
}
