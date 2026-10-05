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

function value(record: ProviderObservation, field: MergeField): unknown {
  const fields = record.record.studioMetadata?.fields as
    Partial<Record<MergeField, unknown>> | undefined;
  return fields?.[field] ?? record.record[field];
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
    studioId: lead.record.studioId ?? lead.studioId,
    studio: lead.record.studio ?? lead.studio,
    fieldProvenance: {},
  };
  const provenance: Record<string, string> = {};

  for (const field of fields) {
    const candidates = ranked(observations, field, policy).filter((item) =>
      present(value(item, field)),
    );
    const winner =
      field === "releaseDate" && policy.oldestDate
        ? [...candidates].sort(
            (first, second) =>
              String(value(first, "releaseDate")).localeCompare(
                String(value(second, "releaseDate")),
              ) ||
              ranked(observations, field, policy).indexOf(first) -
                ranked(observations, field, policy).indexOf(second),
          )[0]
        : candidates[0];
    if (!winner) continue;
    Object.assign(output, { [field]: value(winner, field) });
    provenance[field] =
      winner.record.studioMetadata?.fields[
        field as keyof typeof winner.record.studioMetadata.fields
      ] !== undefined
        ? (winner.record.studioMetadata.fieldProvenance?.[field] ?? "studio-site")
        : winner.providerId;
  }

  const durations = observations
    .map((item) => value(item, "durationSec"))
    .filter(
      (duration): duration is number =>
        typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0,
    );
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
            .filter((item) => {
              const duration = value(item, "durationSec");
              return typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0;
            })
            .map((item) =>
              item.record.studioMetadata?.fields.durationSec !== undefined
                ? (item.record.studioMetadata.fieldProvenance?.durationSec ?? "studio-site")
                : item.providerId,
            ),
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
