/**
 * Fansly public API source adapter.
 *
 * Polls https://apiv3.fansly.com for creator posts. Only public/free posts are
 * accessible without a sessionToken; subscriber-only content requires an
 * authenticated browser token which this adapter does not handle.
 *
 * Configuration:
 *   - fanslyUsernames: readonly string[] — Fansly usernames to watch (e.g. ["maximo_garcia"])
 *   - fanslyMinIntervalMs: number — minimum spacing between requests (default 2000)
 *
 * Each username becomes a lane with studioId `fansly-<username>`.
 * Posts are filtered by the rolling window (windowStart to now).
 * Only posts with video attachments (contentType=2) and free access are emitted.
 */
import { z } from "zod";
import { FetchError } from "../core/fetcher.ts";
import type { RawScene, SourceAdapter, SourceContext } from "./types.ts";

const BASE = "https://apiv3.fansly.com";
const MIN_INTERVAL_MS = 2000;
const MAX_POSTS_PER_SYNC = 500;

/** Fansly account response from /api/v1/account?usernames=... */
const AccountResponse = z.object({
  success: z.boolean(),
  response: z.array(
    z.object({
      id: z.string().min(1),
      username: z.string().min(1),
      displayName: z.string().nullable().optional(),
      walls: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
          mainWall: z.boolean().optional(),
          defaultWall: z.boolean().optional(),
        }),
      ),
      avatar: z
        .object({
          variants: z.array(
            z.object({
              location: z.string().url(),
            }),
          ),
        })
        .nullable()
        .optional(),
    }),
  ),
});
type Account = z.infer<typeof AccountResponse>["response"][0];

/** Fansly timeline response from /api/v1/timelinenew/{creatorId} */
const TimelineResponse = z.object({
  success: z.boolean(),
  response: z.object({
    posts: z.array(
      z.object({
        id: z.string().min(1),
        accountId: z.string().min(1),
        content: z.string(),
        fypFlags: z.number().int(),
        createdAt: z.number().int(),
        expiresAt: z.number().int().nullable().optional(),
        attachments: z.array(
          z.object({
            postId: z.string().min(1),
            pos: z.number().int(),
            contentType: z.number().int(), // 1=image, 2=video, 3=bundle
            contentId: z.string().min(1),
          }),
        ),
        likeCount: z.number().int(),
        mediaLikeCount: z.number().int(),
        accountMentions: z
          .array(
            z.object({
              start: z.number().int(),
              end: z.number().int(),
              handle: z.string().min(1),
              accountId: z.string().min(1),
            }),
          )
          .optional(),
      }),
    ),
    accountMedia: z.array(
      z.object({
        id: z.string().min(1),
        accountId: z.string().min(1),
        mediaId: z.string().min(1),
        previewId: z.string().min(1),
        permissionFlags: z.number().int(),
        price: z.number().int(),
        createdAt: z.number().int(),
        deletedAt: z.number().int().nullable().optional(),
        deleted: z.boolean(),
        access: z.boolean(),
        permissions: z.object({
          permissionFlags: z.array(
            z.object({
              id: z.string().min(1),
              accountMediaId: z.string().min(1),
              type: z.number().int(),
              flags: z.number().int(),
              price: z.number().int(),
              metadata: z.string(),
              validAfter: z.number().int().nullable().optional(),
              validBefore: z.number().int().nullable().optional(),
            }),
          ),
        }),
        accountPermissionFlags: z.object({ flags: z.number().int() }).optional(),
        likeCount: z.number().int(),
        media: z.object({
          id: z.string().min(1),
          type: z.number().int(), // 2 = video
          status: z.number().int(),
          accountId: z.string().min(1),
          mimetype: z.string(),
          flags: z.number().int(),
          location: z.string().nullable().optional(),
          width: z.number().int(),
          height: z.number().int(),
          metadata: z.string(),
          updatedAt: z.number().int(),
          createdAt: z.number().int(),
          variants: z.array(
            z.object({
              id: z.string().min(1),
              type: z.number().int(),
              status: z.number().int(),
              mimetype: z.string(),
              flags: z.number().int(),
              location: z.string().nullable().optional(),
              width: z.number().int(),
              height: z.number().int(),
              metadata: z.string(),
              updatedAt: z.number().int(),
              locations: z.array(
                z.object({
                  locationId: z.string().min(1),
                  location: z.string().url(),
                }),
              ),
              nsfwBlock: z.boolean().optional(),
            }),
          ),
          variantHash: z.record(z.string(), z.unknown()).optional(),
          locations: z.array(
            z.object({
              locationId: z.string().min(1),
              location: z.string().url(),
            }),
          ),
          nsfwBlock: z.boolean().optional(),
        }),
        preview: z
          .object({
            id: z.string().min(1),
            type: z.number().int(),
            status: z.number().int(),
            accountId: z.string().min(1),
            mimetype: z.string(),
            flags: z.number().int(),
            location: z.string().nullable().optional(),
            width: z.number().int(),
            height: z.number().int(),
            metadata: z.string(),
            updatedAt: z.number().int(),
            createdAt: z.number().int(),
            variants: z.array(
              z.object({
                id: z.string().min(1),
                type: z.number().int(),
                status: z.number().int(),
                mimetype: z.string(),
                flags: z.number().int(),
                location: z.string().nullable().optional(),
                width: z.number().int(),
                height: z.number().int(),
                metadata: z.string(),
                updatedAt: z.number().int(),
                createdAt: z.number().int(),
                locations: z.array(
                  z.object({
                    locationId: z.string().min(1),
                    location: z.string().url(),
                  }),
                ),
                nsfwBlock: z.boolean().optional(),
              }),
            ),
            variantHash: z.record(z.string(), z.unknown()).optional(),
            locations: z.array(
              z.object({
                locationId: z.string().min(1),
                location: z.string().url(),
              }),
            ),
            nsfwBlock: z.boolean().optional(),
          })
          .optional(),
      }),
    ),
    accounts: z.array(
      z.object({
        id: z.string().min(1),
        username: z.string().min(1),
        displayName: z.string().nullable().optional(),
      }),
    ),
  }),
});
type Timeline = z.infer<typeof TimelineResponse>;

export interface FanslyStudio {
  studioId: string;
  studio: string;
  username: string;
  creatorId?: string;
}

function cleanStudioName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractHashtags(content: string): string[] {
  const tags = content.match(/#[a-zA-Z0-9_]+/g);
  if (!tags) return [];
  return [...new Set(tags.map((t) => t.slice(1).toLowerCase()))];
}

function extractMentions(content: string): string[] {
  const mentions = content.match(/@[a-zA-Z0-9_.]+/g);
  if (!mentions) return [];
  return [...new Set(mentions.map((m) => m.slice(1)))];
}

function extractTitle(content: string): string {
  // First line before any double newline or URL
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("http")) {
      return trimmed;
    }
  }
  return content.slice(0, 100).trim();
}

function findMedia(accountMedia: Timeline["response"]["accountMedia"], contentId: string) {
  return accountMedia.find((am) => am.id === contentId);
}

function findVideoVariant(media: Timeline["response"]["accountMedia"][0]["media"]) {
  if (!media || media.type !== 2) return null; // type 2 = video
  // Prefer HLS/DASH master playlist (type 302 or 303)
  const master = media.variants.find((v) => v.type === 302 || v.type === 303);
  if (master) return master;
  // Fallback to highest resolution MP4 variant
  const mp4 = media.variants.find((v) => v.mimetype === "video/mp4");
  return mp4 ?? null;
}

function getBestThumbnail(media: Timeline["response"]["accountMedia"][0]["media"]): string {
  if (!media) return "";
  // Prefer preview thumbnail (type 1)
  const thumb = media.variants.find((v) => v.type === 1 && v.location);
  if (thumb?.location) return thumb.location;
  // Fallback to any variant with location
  const any = media.variants.find((v) => v.location);
  return any?.location ?? "";
}

export function createFanslySource(options: {
  usernames: readonly string[];
  minIntervalMs?: number;
}): SourceAdapter {
  const usernames = [...new Set(options.usernames)].filter(Boolean);
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;

  return {
    id: "fansly",
    name: "Fansly",
    authority: {
      name: "Fansly",
      url: BASE,
      role: "Creator post catalogue (public posts only)",
    },
    matcher: "sxyprn+eporner",
    async fetch(windowStart, ctx) {
      if (usernames.length === 0) {
        throw new Error("Fansly: no usernames configured (set LISZT_FANSLY_USERNAMES)");
      }

      let lastRequestAt = 0;
      const fetchJson = async <T = unknown>(url: string): Promise<T> => {
        const wait = minIntervalMs - (Date.now() - lastRequestAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastRequestAt = Date.now();
        return ctx.fetcher.json<T>(url);
      };

      const windowStartTs = Math.floor(new Date(windowStart).getTime() / 1000);
      const windowEndTs = Math.floor(ctx.now.getTime() / 1000);

      // Resolve usernames to creator IDs
      const studioMap = new Map<string, FanslyStudio>();
      for (const username of usernames) {
        studioMap.set(username, {
          studioId: `fansly-${username}`,
          studio: username,
          username,
        });
      }

      const scenes: RawScene[] = [];

      for (const [username, studio] of studioMap) {
        // 1. Resolve username -> creator ID
        if (!studio.creatorId) {
          const accountUrl = `${BASE}/api/v1/account?usernames=${encodeURIComponent(username)}&ngsw-bypass=true`;
          try {
            const accountData = await fetchJson(accountUrl);
            const parsed = AccountResponse.parse(accountData);
            const account = parsed.response[0];
            if (!account) {
              ctx.log("Fansly: username not found", { username });
              continue;
            }
            studio.creatorId = account.id;
            ctx.log("Fansly: resolved creator", { username, creatorId: account.id });
          } catch (error) {
            if (error instanceof FetchError && error.kind === "definitive") {
              ctx.log("Fansly: username not found", { username });
              continue;
            }
            throw error;
          }
        }

        // 2. Fetch timeline posts (paginated via before/after)
        let before = 0;
        let after = 0;
        let postCount = 0;

        while (postCount < MAX_POSTS_PER_SYNC) {
          const timelineUrl = `${BASE}/api/v1/timelinenew/${studio.creatorId}?before=${before}&after=${after}&wallId=&contentSearch=&ngsw-bypass=true`;

          let timelineData: Timeline;
          try {
            const raw = await fetchJson(timelineUrl);
            timelineData = TimelineResponse.parse(raw);
          } catch (error) {
            if (error instanceof FetchError && error.kind === "definitive") {
              ctx.log("Fansly: timeline not accessible", { username });
              break;
            }
            throw error;
          }

          const { posts, accountMedia, accounts } = timelineData.response;
          if (posts.length === 0) break;

          // Map contentId -> media for quick lookup
          const mediaMap = new Map<string, Timeline["response"]["accountMedia"][0]>();
          for (const am of accountMedia) mediaMap.set(am.id, am);

          // Map accountId -> account for performer lookup
          const accountMap = new Map<string, { id: string; username: string }>();
          for (const acc of accounts)
            accountMap.set(acc.id, { id: acc.id, username: acc.username });

          let oldestInBatch = windowEndTs;

          for (const post of posts) {
            const postTs = post.createdAt;
            if (postTs < windowStartTs) {
              oldestInBatch = Math.min(oldestInBatch, postTs);
              continue; // outside window, but keep going for pagination
            }
            if (postTs > windowEndTs) continue; // future post (shouldn't happen)

            // Only process posts with video attachments (contentType=2)
            const videoAttachments = post.attachments.filter((a) => a.contentType === 2);
            if (videoAttachments.length === 0) continue;

            // For each video attachment, create a scene
            for (const attachment of videoAttachments) {
              const media = mediaMap.get(attachment.contentId);
              if (!media) continue;

              // Only free/public posts (access=true, price=0, no subscription gating)
              if (!media.access || media.price > 0) continue;

              const videoVariant = findVideoVariant(media.media);
              if (!videoVariant) continue;

              // Build release URL (Fansly post URL)
              const postUrl = `https://fansly.com/post/${post.id}`;

              // Performers: from @mentions + accountMentions
              const mentionedHandles = extractMentions(post.content);
              const performerNames = new Set<string>(mentionedHandles);
              if (post.accountMentions) {
                for (const m of post.accountMentions) performerNames.add(m.handle);
              }
              // Add the creator themselves
              performerNames.add(username);

              // Tags from hashtags
              const tags = extractHashtags(post.content);

              // Duration from media metadata
              let durationSec: number | null = null;
              try {
                const meta = JSON.parse(media.media.metadata);
                if (meta.duration && typeof meta.duration === "number") {
                  durationSec = Math.round(meta.duration);
                }
              } catch {
                // ignore
              }

              // Thumbnail
              const thumbnailUrl = getBestThumbnail(media.media);

              const title = extractTitle(post.content);
              const releaseDate = new Date(postTs * 1000).toISOString().slice(0, 10);

              scenes.push({
                sourceSceneId: `fansly-${post.id}-${attachment.contentId}`,
                studioId: studio.studioId,
                studio: studio.studio,
                title,
                releaseDate,
                durationSec,
                performers: [...performerNames],
                tags,
                thumbnailUrl,
                releaseUrl: postUrl,
                provenance: {
                  source: "Fansly",
                  sourceUrl: BASE,
                  recordUrl: postUrl,
                  sourceSceneId: post.id,
                },
                fieldProvenance: {
                  title: "Fansly",
                  releaseDate: "Fansly",
                  ...(durationSec !== null ? { durationSec: "Fansly" } : {}),
                  ...(thumbnailUrl ? { thumbnailUrl: "Fansly" } : {}),
                },
              });
              postCount++;
            }

            oldestInBatch = Math.min(oldestInBatch, postTs);
          }

          if (posts.length < 50) break; // likely last page
          // Paginate: use oldest post's createdAt as next `before`
          before = oldestInBatch;
          if (before <= windowStartTs) break;
        }
      }

      ctx.log("Fansly fetch complete", {
        usernames: usernames.length,
        scenes: scenes.length,
      });

      if (scenes.length === 0) return { scenes, verifiedEmpty: true };
      return { scenes, verifiedEmpty: false };
    },
  };
}
