import { renderSourceHealth, renderSourceHealthSummary } from "./source-health.js";

const $ = (selector) => document.querySelector(selector);
const list = $("#list");
const empty = $("#empty");
const search = $("#search");
const sort = $("#sort");
const studio = $("#studio");
const count = $("#count");
const notices = $("#notices");
const scenesTotal = $("#stat-scenes");
const linkedTotal = $("#stat-linked");
const linkRate = $("#link-rate");
const studiosTotal = $("#stat-studios");
const lastChecked = $("#last-checked");
const refreshState = $("#refresh-state");
const refreshButton = $("#refresh");
const sourcesList = $("#sources-list");
const sourceSummary = $("#source-summary");
let scenes = [];
let statuses = [];
let refreshing = false;

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const niceDate = (value) => {
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? "Date unknown" : date.toLocaleDateString("en", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
};
const safeUrl = (value) => {
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : ""; } catch { return ""; }
};
/** Live HTTPS links, deduplicated by normalized URL. Dead links live in a separate array. */
const linksFor = (scene) => {
  const items = Array.isArray(scene.videoUrls) ? scene.videoUrls : [];
  const seen = new Set();
  return items.filter((item) => {
    const url = safeUrl(item?.url);
    if (!item || !url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
};

function render() {
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = scenes.filter((scene) =>
    (studio.value === "all" || scene.labelId === studio.value) &&
    [scene.title, scene.label, ...(scene.performers || [])].join(" ").toLocaleLowerCase().includes(query));
  filtered.sort((a, b) => sort.value === "title"
    ? a.title.localeCompare(b.title)
    : (sort.value === "oldest" ? 1 : -1) * String(a.releaseDate || "").localeCompare(String(b.releaseDate || "")));
  count.textContent = `${filtered.length} ${filtered.length === 1 ? "release" : "releases"}`;
  empty.hidden = filtered.length > 0;
  list.hidden = filtered.length === 0;
  const groups = new Map();
  for (const scene of filtered) {
    const date = new Date(`${scene.releaseDate}T12:00:00Z`);
    const month = Number.isNaN(date.getTime()) ? "Undated" : date.toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });
    groups.set(month, [...(groups.get(month) || []), scene]);
  }
  list.innerHTML = [...groups].map(([month, items]) => `<section class="month-group"><div class="month-heading"><h3>${esc(month)}</h3><span>${items.length} RELEASE${items.length === 1 ? "" : "S"}</span></div>${items.map((scene) => {
    const initials = (scene.title || "L").split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
    const image = safeUrl(scene.thumbnailUrl);
    const thumb = image ? `<img src="${esc(image)}" loading="lazy" alt="">` : `<span class="thumb-initials">${esc(initials)}</span>`;
    const links = linksFor(scene);
    const sourceTotals = new Map();
    for (const item of links) sourceTotals.set(item.source, (sourceTotals.get(item.source) || 0) + 1);
    const sourceIndexes = new Map();
    const outbound = links.map((item) => {
      const index = (sourceIndexes.get(item.source) || 0) + 1;
      sourceIndexes.set(item.source, index);
      const label = sourceTotals.get(item.source) > 1 ? `${item.source} ${index}` : item.source;
      return `<a class="source-link source-link--${esc(item.source)}" href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer" title="Open on ${esc(item.source)}">${esc(label)} <span>↗</span></a>`;
    }).join("");
    const releaseUrl = safeUrl(scene.releaseUrl);
    const lowConfidence = scene.videoMatching && scene.videoMatching.confidence === "low";
    const flag = scene.metadataPoor ? '<span class="review-tag" title="Metadata-poor or low-confidence match; inspect before trusting">REVIEW</span>' : (lowConfidence ? '<span class="review-tag" title="No identity evidence: this title names neither the performer nor the scene, so the match was chosen on view count alone. Worth checking by hand.">LOW CONFIDENCE</span>' : "");
    return `<article class="release-row"><time class="release-date" datetime="${esc(scene.releaseDate)}"><strong>${esc(niceDate(scene.releaseDate).split(" ")[0])}</strong><span>${esc(niceDate(scene.releaseDate).split(" ").slice(1).join(" "))}</span></time><div class="release-thumb">${thumb}</div><div class="release-main"><div class="release-meta"><span class="studio-tag">${esc(scene.label)}</span>${flag}${scene.durationSec ? `<span>${Math.round(scene.durationSec / 60)} MIN</span>` : ""}</div><h4>${esc(scene.title)}</h4><p class="performers">${(scene.performers || []).length ? scene.performers.map(esc).join(" <i>·</i> ") : "Performer information unavailable"}</p></div><div class="release-links">${outbound || '<span class="unlinked">No verified link</span>'}${releaseUrl ? `<a class="release-page" href="${esc(releaseUrl)}" target="_blank" rel="noopener noreferrer">Release page ↗</a>` : ""}</div></article>`;
  }).join("")}</section>`).join("");
}

function renderSources() {
  sourceSummary.innerHTML = renderSourceHealthSummary(statuses);
  sourcesList.innerHTML = statuses.map((item) => {
    const authority = item.authority || {};
    const owned = scenes.filter((scene) => scene.sourceId === item.sourceId);
    const linked = owned.filter((scene) => linksFor(scene).length).length;
    const total = owned.length;
    const state = item.lastError ? (String(item.lastError).includes("not configured") ? "setup" : "error") : "ok";
    const url = safeUrl(authority.url);
    return `<article class="source-card source-card--${state}"><div class="source-card-top"><span class="status-pill"><i></i>${state === "ok" ? "HEALTHY" : state === "setup" ? "SETUP REQUIRED" : "NEEDS ATTENTION"}</span><span class="source-mark">${esc((authority.name || "S").slice(0, 1))}</span></div><p class="source-role">${esc(authority.role || "Catalogue source")}</p><h3>${esc(item.name)}</h3><p class="source-provider">via ${esc(authority.name || "configured source")}</p><div class="source-metrics"><span><strong>${total}</strong> releases</span><span><strong>${total ? Math.round(linked / total * 100) : 0}%</strong> linked</span></div><div class="source-health">${renderSourceHealth(item, scenes)}</div><div class="source-card-bottom"><span>Last good: ${item.lastSuccessAt ? esc(new Date(item.lastSuccessAt).toLocaleDateString()) : "—"}</span>${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">Open source ↗</a>` : ""}</div></article>`;
  }).join("");
}

function apply(data) {
  scenes = Array.isArray(data.scenes) ? data.scenes : [];
  statuses = Array.isArray(data.sources) ? data.sources : [];
  refreshing = Boolean(data.refreshing);
  const stats = data.stats || {};
  scenesTotal.textContent = Number(stats.total ?? scenes.length).toLocaleString();
  linkedTotal.textContent = Number(stats.live ?? 0).toLocaleString();
  linkRate.textContent = `${stats.total ? Math.round((stats.live / stats.total) * 100) : 0}% of catalogue`;
  studiosTotal.textContent = statuses.length.toLocaleString();
  lastChecked.textContent = data.latestRun && data.latestRun.endedAt ? new Date(data.latestRun.endedAt).toLocaleString("en", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
  refreshState.textContent = refreshing
    ? "Refresh in progress…"
    : data.latestRun
      ? (data.latestRun.ok ? "Catalogue up to date" : "Last refresh had source failures")
      : "Waiting for first refresh";
  refreshButton.disabled = refreshing;
  const selected = studio.value;
  studio.replaceChildren(new Option("All studios", "all"));
  studio.insertAdjacentHTML("beforeend", statuses.map((item) => `<option value="${esc(item.labelId)}">${esc(item.label || item.name)} · ${scenes.filter((scene) => scene.labelId === item.labelId).length}</option>`).join(""));
  if ([...studio.options].some((option) => option.value === selected)) studio.value = selected;
  renderSources();
  render();
}

async function load() {
  const response = await fetch("/api/scenes", { cache: "no-store" });
  if (response.status === 401) { window.location.href = "/login"; return; }
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  apply(await response.json());
}

search.addEventListener("input", render);
sort.addEventListener("change", render);
studio.addEventListener("change", render);
refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  refreshState.textContent = "Refresh requested…";
  try { await fetch("/api/refresh", { method: "POST" }); } catch { /* the poll below reports state */ }
  pollUntilIdle();
});
async function pollUntilIdle() {
  try { await load(); } catch { /* keep polling */ }
  if (refreshing) setTimeout(pollUntilIdle, 4000);
}
$("#export").addEventListener("click", () => {
  const headings = ["studio", "title", "release_date", "performers", "release_url", "video_sources"];
  const rows = scenes.map((scene) => [scene.label, scene.title, scene.releaseDate, (scene.performers || []).join("; "), scene.releaseUrl, linksFor(scene).map((item) => item.url).join("; ")]);
  const csv = [headings, ...rows].map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  anchor.download = "liszt-catalogue.csv";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});
document.querySelectorAll("[data-nav]").forEach((link) => link.addEventListener("click", () => {
  document.querySelectorAll("[data-nav]").forEach((item) => item.classList.toggle("active", item === link));
}));
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); search.focus(); }
});
try {
  await load();
  if (refreshing) pollUntilIdle();
} catch (error) {
  notices.innerHTML = `<div class="notice notice-warning">Catalogue unavailable: ${esc(error.message)}</div>`;
  refreshState.textContent = "Unable to load catalogue";
}