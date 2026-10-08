import { epornerVideoId, validEpornerUrl } from "./eporner.js";
import { validSxyprnUrl } from "./sxyprn.js";
export const REVERIFY_SLICE_SIZE = 25;
export const REVERIFY_STRIKE_LIMIT = 2;
export const VERIFY_TIMEOUT_MS = 15_000;
const EPORNER_VIDEO_URL = "https://www.eporner.com/api/v2/video/id/";
function linkUrl(link) {
  return link.source === "sxyprn" ? validSxyprnUrl(link.url) : validEpornerUrl(link.url);
}
function verifiedTime(link) {
  const parsed = Date.parse(link.verifiedAt);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}
export function selectReverifySlice(scenes, limit = REVERIFY_SLICE_SIZE) {
  const candidates = [];
  for (const scene of scenes) {
    for (const link of scene.videoUrls) {
      if (linkUrl(link)) candidates.push({ sceneId: scene.id, link });
    }
  }
  return candidates.sort((a, b) => verifiedTime(a.link) - verifiedTime(b.link)).slice(0, limit);
}
export function createLinkVerifier({ fetcher, timeoutMs = VERIFY_TIMEOUT_MS }) {
  return async (link) => {
    if (link.source === "sxyprn") {
      let response;
      try {
        response = await fetcher.fetch(link.url, {
          headers: { accept: "text/html" },
          timeoutMs,
        });
      } catch (error) {
        return { status: "inconclusive", reason: error.message };
      }
      if (response.status === 404 || response.status === 410) {
        return { status: "dead", reason: `sxyprn watch page returned HTTP ${response.status}` };
      }
      return response.ok
        ? { status: "live" }
        : { status: "inconclusive", reason: `sxyprn watch page returned HTTP ${response.status}` };
    }
    const id = epornerVideoId(link.url);
    if (!id) return { status: "inconclusive", reason: "eporner link has no video id" };
    const url = new URL(EPORNER_VIDEO_URL);
    url.searchParams.set("id", id);
    url.searchParams.set("format", "json");
    let response;
    try {
      response = await fetcher.fetch(url.href, {
        headers: { accept: "application/json" },
        timeoutMs,
      });
    } catch (error) {
      return { status: "inconclusive", reason: error.message };
    }
    if (!response.ok) {
      return { status: "inconclusive", reason: `eporner lookup returned HTTP ${response.status}` };
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType && !contentType.includes("json")) {
      return {
        status: "inconclusive",
        reason: `eporner lookup returned a non-JSON body (${contentType}); treating as an anti-bot wall, not a deletion`,
      };
    }
    let video;
    try {
      video = await response.json();
    } catch (error) {
      return { status: "inconclusive", reason: error.message };
    }
    if (Array.isArray(video) && video.length === 0) {
      return { status: "dead", reason: "eporner video/id lookup found no record" };
    }
    return video && typeof video === "object"
      ? { status: "live" }
      : { status: "inconclusive", reason: "eporner lookup returned an invalid record" };
  };
}
export async function reverifyLinks(
  scenes,
  { verify, now, limit = REVERIFY_SLICE_SIZE, fatal, onProgress },
) {
  const slice = selectReverifySlice(scenes, limit);
  onProgress?.(0, slice.length);
  if (!slice.length) return { scenes, changed: [], strikes: 0, dead: 0 };
  const outcomes = [];
  for (const { link } of slice) {
    try {
      outcomes.push(await verify(link));
    } catch {
      outcomes.push({ status: "inconclusive" });
    }
    onProgress?.(outcomes.length, slice.length);
  }
  const byScene = new Map();
  let strikes = 0;
  let dead = 0;
  slice.forEach(({ sceneId, link }, index) => {
    const outcome = outcomes[index];
    const at = now.toISOString();
    const updates = byScene.get(sceneId) ?? new Map();
    byScene.set(sceneId, updates);
    if (outcome.status === "live") {
      updates.set(link.url, { link: { ...link, verifiedAt: at, verifyFailures: 0 } });
      return;
    }
    if (outcome.status !== "dead") {
      updates.set(link.url, { link });
      return;
    }
    const failures = link.verifyFailures + 1;
    if (failures < REVERIFY_STRIKE_LIMIT) {
      strikes += 1;
      updates.set(link.url, { link: { ...link, verifyFailures: failures } });
      return;
    }
    dead += 1;
    updates.set(link.url, { dead: { deadAt: at, deadReason: outcome.reason ?? "Link not found" } });
  });
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const changed = [];
  for (const [sceneId, updates] of byScene) {
    const scene = byId.get(sceneId);
    if (!scene) continue;
    const videoUrls = [];
    const newDead = [];
    for (const link of scene.videoUrls) {
      const update = updates.get(link.url);
      if (!update) {
        videoUrls.push(link);
        continue;
      }
      if (update.dead) {
        newDead.push({ source: link.source, url: link.url, ...update.dead });
        continue;
      }
      if (update.link) videoUrls.push(update.link);
    }
    const live = fatal ? videoUrls.filter((link) => !fatal(link)) : videoUrls;
    const updated = {
      ...scene,
      videoUrls: live,
      deadVideoUrls: newDead.length ? [...scene.deadVideoUrls, ...newDead] : scene.deadVideoUrls,
    };
    if (!live.length) updated.videoCheckedAt = null;
    changed.push(updated);
  }
  const changedById = new Map(changed.map((scene) => [scene.id, scene]));
  return {
    scenes: scenes.map((scene) => changedById.get(scene.id) ?? scene),
    changed,
    strikes,
    dead,
  };
}
