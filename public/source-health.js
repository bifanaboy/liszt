const escapeHtml = (value) => String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);

// A missing credential is a deploy configuration problem, not a source outage.
// It gets its own state so the fix is obvious.
const CONFIG_ERROR = /not configured|missing\b[^.]*\b(?:key|token|secret|credential)|\b(?:key|token|secret|credential)s?\b[^.]*\b(?:missing|required|invalid|expired|absent)|\benv(?:ironment)? variable|unauthorized|forbidden|HTTP (?:401|403)/i;

export function classifySourceStatus(error) {
  if (!error) return "ok";
  return CONFIG_ERROR.test(String(error)) ? "config" : "failing";
}

export function isLiveLink(link) {
  return Boolean(link) && typeof link.url === "string";
}

export function sourceHealth(source, scenes) {
  const owned = (Array.isArray(scenes) ? scenes : []).filter((scene) => scene.sourceId === source?.sourceId);
  const liveCount = owned.filter((scene) => (scene.videoUrls || []).some(isLiveLink)).length;
  return {
    label: classifySourceStatus(source?.lastError),
    sceneCount: owned.length,
    liveCount,
    matchPercent: owned.length ? Math.round((liveCount / owned.length) * 100) : null,
    lastSuccessAt: source?.lastSuccessAt || null,
  };
}

function formatRefresh(value) {
  return value ? new Date(value).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "Not yet refreshed";
}

const STATE_LABEL = { ok: "Sync ok", failing: "Sync failing", config: "Not configured" };
const STATE_HINT = { config: "Deploy configuration, not a source outage" };

export function sourceStateLabel(error) {
  return STATE_LABEL[classifySourceStatus(error)];
}

export function renderSourceHealth(source, scenes) {
  const health = sourceHealth(source, scenes);
  const match = health.matchPercent === null ? "—" : `${health.matchPercent}%`;
  const hint = STATE_HINT[health.label] ? `<p class="source-state__hint">${escapeHtml(STATE_HINT[health.label])}</p>` : "";
  return `<p class="source-state source-state--${health.label}">${escapeHtml(STATE_LABEL[health.label])}</p>${hint}<dl><div><dt>Scenes</dt><dd>${health.sceneCount}</dd></div><div><dt>Match rate</dt><dd>${match}</dd></div><div><dt>Last successful refresh</dt><dd>${escapeHtml(formatRefresh(health.lastSuccessAt))}</dd></div></dl>${source?.lastError ? `<p class="source-error">${escapeHtml(source.lastError)}</p>` : ""}`;
}

// The catalogue carries at most one compact pointer; the error text itself lives in Sources.
export function renderSourceHealthSummary(sources) {
  const counts = { failing: 0, config: 0 };
  for (const source of Array.isArray(sources) ? sources : []) {
    const label = classifySourceStatus(source?.lastError);
    if (label !== "ok") counts[label] += 1;
  }
  const parts = [];
  if (counts.failing) parts.push(`${counts.failing} source${counts.failing === 1 ? "" : "s"} failing`);
  if (counts.config) parts.push(`${counts.config} source${counts.config === 1 ? "" : "s"} not configured`);
  if (!parts.length) return "";
  return `<div class="notice notice--pointer" role="status"><a href="#sources">${escapeHtml(parts.join(" · "))} — see Sources</a></div>`;
}