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
  return [...observations].sort((lead, next) => {
    const leadId = lead.providerId.startsWith("tpdb-site-") ? "tpdb-watchlist" : lead.providerId;
    const nextId = next.providerId.startsWith("tpdb-site-") ? "tpdb-watchlist" : next.providerId;
    const leadRank = priority.indexOf(leadId);
    const nextRank = priority.indexOf(nextId);
    const first = leadRank < 0 ? priority.length : leadRank;
    const second = nextRank < 0 ? priority.length : nextRank;
    return (
      first - second ||
      lead.providerId.localeCompare(next.providerId) ||
      lead.recordId.localeCompare(next.recordId)
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
  const lead = ordered[0]!;
  const output: RawScene = {
    ...lead.record,
    sourceSceneId: lead.recordId,
    studioId: lead.studioId,
    studio: lead.studio,
    fieldProvenance: {},
  };
  const provenance: Record<string, string> = {};

  for (const field of fields) {
    const candidates = ranked(observations, field, policy).filter((item) =>
      present(item.record[field]),
    );
    const winner =
      field === "releaseDate" && policy.oldestDate
        ? [...candidates].sort(
            (first, second) =>
              first.record.releaseDate.localeCompare(second.record.releaseDate) ||
              ranked(observations, field, policy).indexOf(first) -
                ranked(observations, field, policy).indexOf(second),
          )[0]
        : candidates[0];
    if (!winner) continue;
    Object.assign(output, { [field]: winner.record[field] });
    provenance[field] = winner.providerId;
  }

  const durations = observations
    .map((item) => item.record.durationSec)
    .filter((value): value is number => Number.isSafeInteger(value) && (value ?? 0) > 0);
  if (durations.length) {
    const minimum = Math.min(...durations);
    const maximum = Math.max(...durations);
    if (minimum === maximum) {
      output.durationSec = minimum;
    } else {
      output.durationSec = null;
      output.durationRange = { minSec: minimum, maxSec: maximum };
      output.durationReview = maximum - minimum > 1;
      provenance.durationSec = [
        ...new Set(
          observations
            .filter(
              (item) => item.record.durationSec !== undefined && item.record.durationSec !== null,
            )
            .map((item) => item.providerId),
        ),
      ].join(", ");
    }
  }

  output.source = lead.providerId;
  output.fieldProvenance = provenance;
  output.provenance = {
    source: lead.providerId,
    sourceSceneId: lead.recordId,
    ...(lead.record.provenance?.sourceUrl ? { sourceUrl: lead.record.provenance.sourceUrl } : {}),
    ...(lead.record.releaseUrl ? { recordUrl: lead.record.releaseUrl } : {}),
  };
  return output;
}
