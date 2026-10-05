import type { MergeField, MergePolicy, ProviderObservation, RawScene } from "../sources/types.ts";

const fields: readonly MergeField[] = [
  "title",
  "releaseDate",
  "performers",
  "durationSec",
  "thumbnailUrl",
  "releaseUrl",
  "tags",
  "storeId",
  "launchDate",
  "previewUrl",
  "price",
  "studioCode",
];

function present(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  return !Array.isArray(value) || value.length > 0;
}

function ranked(
  observations: readonly ProviderObservation[],
  field: MergeField,
  policy: MergePolicy,
): ProviderObservation[] {
  const priority = policy.priority?.[field] ?? [];
  return [...observations].sort((first, second) => {
    const left = priority.indexOf(first.providerId);
    const right = priority.indexOf(second.providerId);
    const leftRank = left < 0 ? priority.length : left;
    const rightRank = right < 0 ? priority.length : right;
    return (
      leftRank - rightRank ||
      first.providerId.localeCompare(second.providerId) ||
      first.recordId.localeCompare(second.recordId)
    );
  });
}

/** Build one deterministic field set from retained provider observations. */
export function mergeRelease(
  observations: readonly ProviderObservation[],
  policy: MergePolicy = {},
): RawScene {
  if (!observations.length) throw new Error("Cannot merge a release without observations");

  const ordered = ranked(observations, "title", policy);
  const first = ordered[0]!;
  const merged: RawScene = {
    ...first.record,
    sourceSceneId: first.recordId,
    studioId: first.studioId,
    studio: first.studio,
    fieldProvenance: {},
  };
  const provenance: Record<string, string> = {};

  for (const field of fields) {
    const winner = ranked(observations, field, policy).find((item) => present(item.record[field]));
    if (!winner) continue;
    Object.assign(merged, { [field]: winner.record[field] });
    provenance[field] = winner.providerId;
  }

  merged.source = first.providerId;
  merged.fieldProvenance = provenance;
  merged.provenance = {
    source: first.providerId,
    sourceSceneId: first.recordId,
    ...(first.record.provenance?.sourceUrl ? { sourceUrl: first.record.provenance.sourceUrl } : {}),
    ...(first.record.releaseUrl ? { recordUrl: first.record.releaseUrl } : {}),
  };
  return merged;
}
