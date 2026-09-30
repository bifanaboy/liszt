/**
 * Link re-verify. Each sync re-verifies a rotating slice of the stalest stored
 * links, cheaply:
 *
 *   - sxyprn links by fetching the watch page; a 404/410 is definitive.
 *   - eporner links (both `eporner` and `eporner-pool`) via the `video/id` API,
 *     where an EMPTY result is definitive deletion (the API never answers 404).
 *
 * Only a DEFINITIVE non-existence counts as a strike. Timeouts, 403 anti-bot
 * walls, 5xx responses, and malformed bodies are inconclusive and do not count.
 * After two consecutive definitive failures a link moves out of `videoUrls`
 * into `deadVideoUrls`, where it stays for history and is hidden from the
 * dashboard. When a scene's last live link dies, `videoCheckedAt` is cleared so
 * it re-enters normal resolution on a later cycle.
 */
import { epornerVideoId, validEpornerUrl } from "./eporner.ts";
import { validSxyprnUrl } from "./sxyprn.ts";
import type { Fetcher } from "../sources/types.ts";
import type { DeadVideoLink, Scene, VideoLink } from "../core/schema.ts";

export const REVERIFY_SLICE_SIZE = 25;
export const REVERIFY_STRIKE_LIMIT = 2;
export const VERIFY_TIMEOUT_MS = 15_000;
const EPORNER_VIDEO_URL = "https://www.eporner.com/api/v2/video/id/";

export interface VerifyOutcome {
  status: "live" | "dead" | "inconclusive";
  reason?: string;
}

/** A link counts toward re-verify only when its URL is a well-formed source URL. */
function linkUrl(link: VideoLink): boolean {
  return link.source === "sxyprn" ? validSxyprnUrl(link.url) : validEpornerUrl(link.url);
}

function verifiedTime(link: VideoLink): number {
  const parsed = Date.parse(link.verifiedAt);
  return Number.isFinite(parsed) ? parsed : -Infinity;
}

/** The stalest re-verifiable links, at most `limit`, oldest `verifiedAt` first. */
export function selectReverifySlice(
  scenes: Scene[],
  limit = REVERIFY_SLICE_SIZE,
): { sceneId: string; link: VideoLink }[] {
  const candidates: { sceneId: string; link: VideoLink }[] = [];
  for (const scene of scenes) {
    for (const link of scene.videoUrls) {
      if (linkUrl(link)) candidates.push({ sceneId: scene.id, link });
    }
  }
  return candidates.sort((a, b) => verifiedTime(a.link) - verifiedTime(b.link)).slice(0, limit);
}

/** Verify one stored link. Definitive non-existence only. */
export function createLinkVerifier({
  fetcher,
  timeoutMs = VERIFY_TIMEOUT_MS,
}: {
  fetcher: Fetcher;
  timeoutMs?: number;
}) {
  return async (link: VideoLink): Promise<VerifyOutcome> => {
    if (link.source === "sxyprn") {
      let response: Response;
      try {
        response = await fetcher.fetch(link.url, {
          headers: { accept: "text/html" },
          timeoutMs,
        });
      } catch (error) {
        return { status: "inconclusive", reason: (error as Error).message };
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
    let response: Response;
    try {
      response = await fetcher.fetch(url.href, {
        headers: { accept: "application/json" },
        timeoutMs,
      });
    } catch (error) {
      return { status: "inconclusive", reason: (error as Error).message };
    }
    if (!response.ok) {
      return { status: "inconclusive", reason: `eporner lookup returned HTTP ${response.status}` };
    }
    let video: unknown;
    try {
      video = await response.json();
    } catch (error) {
      return { status: "inconclusive", reason: (error as Error).message };
    }
    // The API answers an unknown id with an empty array, never a 404.
    if (Array.isArray(video) && video.length === 0) {
      return { status: "dead", reason: "eporner video/id lookup found no record" };
    }
    return video && typeof video === "object"
      ? { status: "live" }
      : { status: "inconclusive", reason: "eporner lookup returned an invalid record" };
  };
}

/**
 * Re-verify the stalest slice of each scene's live links. A link reaching the
 * strike limit moves into `deadVideoUrls`; when a scene's last live link dies,
 * `videoCheckedAt` is cleared so it re-enters normal resolution.
 */
export async function reverifyLinks(
  scenes: Scene[],
  {
    verify,
    now,
    limit = REVERIFY_SLICE_SIZE,
    fatal,
  }: {
    verify: (link: VideoLink) => Promise<VerifyOutcome>;
    now: Date;
    limit?: number;
    /** True when the URL was already proven dead and must not return. */
    fatal?: (link: VideoLink) => boolean;
  },
): Promise<{ scenes: Scene[]; changed: Scene[]; strikes: number; dead: number }> {
  const slice = selectReverifySlice(scenes, limit);
  if (!slice.length) return { scenes, changed: [], strikes: 0, dead: 0 };

  const outcomes: VerifyOutcome[] = [];
  for (const { link } of slice) {
    try {
      outcomes.push(await verify(link));
    } catch {
      outcomes.push({ status: "inconclusive" });
    }
  }

  interface Update {
    link?: VideoLink;
    dead?: { deadAt: string; deadReason: string };
  }
  const byScene = new Map<string, Map<string, Update>>();
  let strikes = 0;
  let dead = 0;
  slice.forEach(({ sceneId, link }, index) => {
    const outcome = outcomes[index] as VerifyOutcome;
    const at = now.toISOString();
    const updates = byScene.get(sceneId) ?? new Map<string, Update>();
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
  const changed: Scene[] = [];
  for (const [sceneId, updates] of byScene) {
    const scene = byId.get(sceneId);
    if (!scene) continue;
    const videoUrls: VideoLink[] = [];
    const newDead: DeadVideoLink[] = [];
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
    const updated: Scene = {
      ...scene,
      videoUrls: live,
      deadVideoUrls: newDead.length ? [...scene.deadVideoUrls, ...newDead] : scene.deadVideoUrls,
    };
    if (!live.length && newDead.length) updated.videoCheckedAt = null;
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