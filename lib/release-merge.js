const fields = [
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
function present(value) {
    if (value === undefined || value === null || value === "")
        return false;
    return !Array.isArray(value) || value.length > 0;
}
function value(record, field) {
    const fields = record.record.studioMetadata?.fields;
    return fields?.[field] ?? record.record[field];
}
function ranked(observations, field, policy) {
    const priority = policy.priority?.[field] ?? [];
    return [...observations].sort((lead, next) => {
        const leadId = lead.providerId.startsWith("tpdb-site-") ? "tpdb-watchlist" : lead.providerId;
        const nextId = next.providerId.startsWith("tpdb-site-") ? "tpdb-watchlist" : next.providerId;
        const leadRank = priority.indexOf(leadId);
        const nextRank = priority.indexOf(nextId);
        const first = leadRank < 0 ? priority.length : leadRank;
        const second = nextRank < 0 ? priority.length : nextRank;
        return (first - second ||
            lead.providerId.localeCompare(next.providerId) ||
            lead.recordId.localeCompare(next.recordId));
    });
}
export function mergeRelease(observations, policy = {}) {
    if (!observations.length)
        throw new Error("Cannot merge a release without observations");
    const ordered = ranked(observations, "title", policy);
    const lead = ordered[0];
    const output = {
        ...lead.record,
        sourceSceneId: lead.recordId,
        studioId: lead.record.studioId ?? lead.studioId,
        studio: lead.record.studio ?? lead.studio,
        fieldProvenance: {},
    };
    const provenance = {};
    for (const field of fields) {
        const candidates = ranked(observations, field, policy).filter((item) => present(value(item, field)));
        const winner = field === "releaseDate" && policy.oldestDate
            ? [...candidates].sort((first, second) => String(value(first, "releaseDate")).localeCompare(String(value(second, "releaseDate"))) ||
                ranked(observations, field, policy).indexOf(first) -
                    ranked(observations, field, policy).indexOf(second))[0]
            : candidates[0];
        if (!winner)
            continue;
        Object.assign(output, { [field]: value(winner, field) });
        provenance[field] =
            winner.record.studioMetadata?.fields[field] !== undefined
                ? (winner.record.studioMetadata.fieldProvenance?.[field] ?? "studio-site")
                : winner.providerId;
    }
    const durations = observations
        .map((item) => value(item, "durationSec"))
        .filter((duration) => typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0);
    if (durations.length) {
        const minimum = Math.min(...durations);
        const maximum = Math.max(...durations);
        if (minimum === maximum) {
            output.durationSec = minimum;
        }
        else {
            output.durationSec = null;
            output.durationRange = { minSec: minimum, maxSec: maximum };
            output.durationReview = maximum - minimum > 1;
            provenance.durationSec = [
                ...new Set(observations
                    .filter((item) => {
                    const duration = value(item, "durationSec");
                    return typeof duration === "number" && Number.isSafeInteger(duration) && duration > 0;
                })
                    .map((item) => item.record.studioMetadata?.fields.durationSec !== undefined
                    ? (item.record.studioMetadata.fieldProvenance?.durationSec ?? "studio-site")
                    : item.providerId)),
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
