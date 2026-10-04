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
  /** The parsed TPDB side, from `parseTpdbStudioUrl`. */
  lookup: TpdbLookup;
  /** What TPDB resolved the lookup to, or undefined when it did not resolve. */
  resolved?: ResolvedTpdbSite;
  /** The parsed Traxxx lane, when a Traxxx address was pasted. */
  lane?: DeclarationLane;
  /** The display name to record. */
  studioName: string;
}

export function buildDeclaration(input: DeclarationInput): StudioLink {
  const { lookup, resolved, lane, studioName } = input;
  const traxxx = lane ? { kind: lane.kind, slug: lane.slug, url: lane.url } : undefined;
  // A Traxxx lane's own tags win: they are what the lane id is built from, and
  // the two sides describing one studio must not disagree about its scope. The
  // TPDB search tags apply only when there is no Traxxx side to carry them.
  const tags = lane?.tags.length ? [...lane.tags] : lookup.tags ? [...lookup.tags] : [];
  const tagsField = tags.length ? { tags } : {};
  return {
    studioId: canonicalStudioId({
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
