const LABEL = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/;
const MAX_SUMMARY_LENGTH = 240;

function safeLabel(value, name) {
  if (typeof value !== "string" || !LABEL.test(value)) {
    throw new TypeError(`Invalid provider failure ${name}`);
  }
  return value;
}

export function sanitizeFailureSummary(value, secrets = []) {
  let summary = String(value)
    .replace(/(\bBearer\s+)\S+/gi, "$1[redacted]")
    .replace(
      /([?&](?:api[_-]?key|key|token|secret|password|authorization|auth)=)[^&#\s]*/gi,
      "$1[redacted]",
    );
  for (const secret of secrets.filter((item) => typeof item === "string" && item.length)) {
    summary = summary.replaceAll(secret, "[redacted]");
  }
  summary = summary.replace(/(https?:\/\/)[^/@\s]+@/gi, "$1[redacted]@");
  summary = summary.replace(/\s*<[^>]+>[\s\S]*$/, " [response body omitted]");
  summary = summary.replace(/\s*\{(?=\s*["'][^"']+["']\s*:)[\s\S]*$/, " [response body omitted]");
  return summary.slice(0, MAX_SUMMARY_LENGTH);
}

export function logProviderFailure(
  { runId, provider, stage, occurredAt, summary },
  { secrets = [] } = {},
) {
  const timestamp = new Date(occurredAt);
  if (!Number.isFinite(timestamp.getTime())) throw new TypeError("Invalid provider failure time");
  if (typeof summary !== "string") throw new TypeError("Invalid provider failure summary");
  const entry = {
    event: "provider_failure",
    runId: safeLabel(runId, "run ID"),
    provider: safeLabel(provider, "provider"),
    stage: safeLabel(stage, "stage"),
    occurredAt: timestamp.toISOString(),
    summary: sanitizeFailureSummary(summary, secrets),
  };
  console.error(JSON.stringify(entry));
}
