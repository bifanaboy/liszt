import { identityTier, pickMatch, parseTimestamp, withinDateWindow } from "../matching.js";
import { mapIsolated } from "../concurrency.js";
import { createExpiringCache } from "./eporner.js";
import { buildQueries, configuredSceneCode } from "./queries.js";
export function validSxyprnUrl(value) {
  try {
    const url = new URL(String(value));
    return (
      url.protocol === "https:" &&
      url.hostname === "sxyprn.com" &&
      /^\/post\/[a-f0-9]{13}\.html$/.test(url.pathname) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function searchSlug(value) {
  return String(value || "")
    .replace(/[`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}
function detailFailureReason(error) {
  if (error instanceof Error) return error.message.trim() || "unknown detail error";
  if (typeof error === "string" && error.trim()) return error.trim();
  return "unknown detail error";
}
export function createSxyprnLookup({
  client,
  maxMatches = 1,
  dateWindowDays,
  durationToleranceSec,
  detailConcurrency = 3,
  cacheTtlMs = 5 * 60_000,
}) {
  const cachedSearch = createExpiringCache({ ttlMs: cacheTtlMs });
  const cachedDetails = createExpiringCache({ ttlMs: cacheTtlMs });
  const search = (query) =>
    cachedSearch(searchSlug(query), () => client.videos.search(searchSlug(query)));
  const details = (url) => cachedDetails(url, () => client.videos.details({ url }));
  return async function lookup(scene) {
    const code = scene.sceneCode ?? configuredSceneCode(scene);
    const queries = buildQueries(scene);
    if (!queries.length || (!Number.isFinite(scene.durationSec) && !scene.durationRange)) return [];
    const allCandidates = new Map();
    let successfulSearches = 0;
    const searchErrors = [];
    for (const query of queries) {
      try {
        const page = await search(query);
        successfulSearches += 1;
        for (const item of page.videos ?? []) {
          if (!validSxyprnUrl(item.url)) continue;
          allCandidates.set(item.url, item);
        }
      } catch (error) {
        searchErrors.push(error.message);
      }
    }
    if (!successfulSearches) {
      const reasons = [...new Set(searchErrors)].slice(0, 3).join("; ");
      throw new Error(`sxyprn search unavailable${reasons ? `: ${reasons}` : ""}`);
    }
    const identity = { ...scene, sceneCode: code };
    const mapped = [...allCandidates.values()].map((item) => ({
      url: String(item.url ?? ""),
      title: String(item.title ?? ""),
      duration: Number(item.durationSeconds),
      views: item.views ?? null,
      isExternal: item.isExternal ?? false,
      ...(item.author ? { author: item.author } : {}),
    }));
    const picked = pickMatch(identity, mapped, { dateWindowDays: null, durationToleranceSec });
    const durationSurvivors = mapped.filter((item) => {
      const duration = Number(item.duration);
      return (
        Number.isFinite(duration) &&
        (scene.durationRange
          ? Math.max(
              scene.durationRange.minSec - duration,
              0,
              duration - scene.durationRange.maxSec,
            )
          : Math.abs(duration - (scene.durationSec ?? 0))) <= (durationToleranceSec ?? 1)
      );
    });
    if (!durationSurvivors.length) return [];
    const cardViews = (candidate) => {
      const raw = candidate.views;
      if (typeof raw === "number") return Number.isFinite(raw) ? raw : -1;
      if (typeof raw !== "string") return -1;
      const value = Number(raw.replace(/[,\s]/g, ""));
      return Number.isFinite(value) ? value : -1;
    };
    const ranked = [
      ...(picked ? [picked.candidate] : []),
      ...durationSurvivors
        .filter((item) => item.url !== picked?.candidate.url)
        .sort(
          (left, right) =>
            Number(left.isExternal) - Number(right.isExternal) ||
            cardViews(right) - cardViews(left) ||
            String(left.url).localeCompare(String(right.url)),
        ),
    ];
    const slice = ranked.slice(0, Math.max(3, maxMatches));
    const fetched = await mapIsolated(
      slice,
      async (item) => {
        try {
          return { detail: await details(item.url) };
        } catch (error) {
          return { detail: null, error };
        }
      },
      detailConcurrency,
    );
    let verifiedPosts = 0;
    const detailErrors = [];
    const verified = [];
    for (let index = 0; index < slice.length; index += 1) {
      const item = slice[index];
      const outcome = fetched[index];
      if (!outcome || outcome.detail === null) {
        if (outcome) detailErrors.push(detailFailureReason(outcome.error));
        continue;
      }
      const detail = outcome.detail;
      verifiedPosts += 1;
      const title = String(detail.title ?? "");
      const duration = Number(detail.durationSeconds ?? item.duration);
      const datePass =
        withinDateWindow(scene.releaseDate, detail.uploadDate ?? null, dateWindowDays) === true;
      const durationPass =
        Number.isFinite(duration) &&
        (Number.isFinite(scene.durationSec) || Boolean(scene.durationRange)) &&
        (scene.durationRange
          ? Math.max(
              scene.durationRange.minSec - duration,
              0,
              duration - scene.durationRange.maxSec,
            )
          : Math.abs(duration - (scene.durationSec ?? 0))) <= (durationToleranceSec ?? 1);
      if (
        validSxyprnUrl(detail.url) &&
        detail.url === item.url &&
        detail.streamUrl &&
        datePass &&
        durationPass
      ) {
        verified.push({
          url: detail.url,
          identityTier: identityTier(identity, title),
          lagDays: lagInDays(scene.releaseDate, detail.uploadDate),
          title,
          duration,
          added: String(detail.uploadDate ?? ""),
          views: detail.views ?? null,
        });
      }
    }
    const reasons = [...new Set(detailErrors)].slice(0, 3).join("; ");
    if (!verifiedPosts)
      throw new Error(`sxyprn post verification unavailable${reasons ? `: ${reasons}` : ""}`);
    return verified;
  };
}
function lagInDays(releaseDate, added) {
  const release = parseTimestamp(releaseDate);
  const uploaded = parseTimestamp(added);
  if (release === null || uploaded === null) return null;
  return Math.round((uploaded - release) / 86_400_000);
}
