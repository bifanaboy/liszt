/** Public store listings only. No login, tag gates, or source-precedence rule. */
import { z } from "zod";
import { setTimeout as pause } from "node:timers/promises";
import { DateOnly, IsoTimestamp, parseAtBoundary } from "../core/schema.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
import type { RawScene, SourceAdapter } from "./types.ts";

function durationSeconds(value: string): number {
  return value.split(":").reduce((seconds, component) => seconds * 60 + Number(component), 0);
}

const Video = z.object({
  id: z.string().regex(/^\d+$/),
  title: z.string().trim().min(1),
  slug: z.string().min(1),
  duration: z
    .string()
    .regex(/^\d+:[0-5]\d(?::[0-5]\d)?$/)
    .refine((value) => Number.isSafeInteger(durationSeconds(value)) && durationSeconds(value) > 0),
  launchDate: IsoTimestamp.refine(
    (value) => DateOnly.safeParse(value.slice(0, 10)).success,
    "invalid calendar date",
  ),
  creator: z.object({ id: z.string().regex(/^\d+$/), stageName: z.string().min(1) }),
  thumbnail: z.object({ url: z.string().url() }).nullish(),
  preview: z.object({ url: z.string().url() }).nullish(),
  price: z.object({
    regular: z.string().regex(/^\d+(?:\.\d+)?$/),
    onSale: z.boolean(),
    free: z.boolean(),
  }),
  tags: z.array(z.string().min(1)).optional(),
});
const Page = z.object({
  data: z.array(Video),
  pagination: z.object({
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
    currentPage: z.number().int().positive(),
    nextPage: z.number().int().positive().nullable().default(null),
  }),
});
const Snapshot = z.object({ fullPulledAt: IsoTimestamp, videos: z.array(Video) });
const WEEK_MS = 7 * 86_400_000;
const MAX_PAGES = 10_000;

export interface ManyVidsOptions {
  storeId: string;
  store?: Pick<SqliteStore, "getSourceSnapshot" | "setSourceSnapshot">;
  minIntervalMs?: number;
}

export function createManyVidsSource({
  storeId,
  store,
  minIntervalMs = 400,
}: ManyVidsOptions): SourceAdapter {
  if (!/^\d+$/.test(storeId)) throw new Error("ManyVids store id must be numeric");
  if (!Number.isFinite(minIntervalMs) || minIntervalMs < 0)
    throw new Error("Invalid ManyVids request interval");
  const id = `manyvids-${storeId}`;
  const base = `https://www.manyvids.com/bff/store/videos/${storeId}/`;
  let memory: string | null = null;
  let lastRequestAt = 0;

  return {
    id,
    name: storeId === "1003095958" ? "ManyVids — Maximo Garcia" : `ManyVids — store ${storeId}`,
    authority: { name: "ManyVids", url: base, role: "Creator storefront" },
    matcher: "sxyprn+eporner",
    creatorStudio: true,
    async fetch(windowStart, ctx) {
      const saved = store ? store.getSourceSnapshot(id) : memory;
      const prior = saved
        ? parseAtBoundary(Snapshot, JSON.parse(saved), `manyvids.snapshot(${storeId})`)
        : null;
      const full = !prior || ctx.now.getTime() - Date.parse(prior.fullPulledAt) >= WEEK_MS;
      const known = new Set(prior?.videos.map((video) => video.id));
      // A successful full scan refreshes the snapshot; catalogue retention is
      // still owned by sync. Incremental scans retain unseen cached records.
      const videos = new Map((full ? [] : (prior?.videos ?? [])).map((video) => [video.id, video]));
      let current = 1;
      let requested = 0;
      while (true) {
        if (++requested > MAX_PAGES)
          throw new Error(`ManyVids ${storeId}: pagination exceeded ${MAX_PAGES} pages`);
        const remaining = minIntervalMs - (Date.now() - lastRequestAt);
        if (remaining > 0) await pause(remaining);
        lastRequestAt = Date.now();
        const url = `${base}?page=${current}`;
        const result = parseAtBoundary(
          Page,
          await ctx.fetcher.json(url),
          `manyvids.page(${storeId}:${current})`,
        );
        const p = result.pagination;
        if (
          p.currentPage !== current ||
          (p.nextPage !== null && (p.nextPage !== current + 1 || p.nextPage > p.totalPages)) ||
          (p.totalPages > 0 && current > p.totalPages) ||
          (p.nextPage === null && current < p.totalPages) ||
          (!result.data.length && (p.total !== 0 || p.nextPage !== null || current !== 1)) ||
          (result.data.length > 0 && p.total === 0)
        ) {
          throw new Error(`ManyVids ${storeId}: inconsistent pagination on page ${current}`);
        }
        for (const video of result.data) {
          if (video.creator.id !== storeId)
            throw new Error(`ManyVids ${storeId}: video belongs to a different store`);
          videos.set(video.id, video);
        }
        ctx.log("ManyVids page fetched", {
          storeId,
          page: current,
          count: result.data.length,
          full,
        });
        if (
          p.nextPage === null ||
          (!full && result.data.length > 0 && result.data.every((video) => known.has(video.id)))
        )
          break;
        current = p.nextPage;
      }
      const snapshot = {
        fullPulledAt: full ? ctx.now.toISOString() : prior!.fullPulledAt,
        videos: [...videos.values()],
      };
      const scenes: RawScene[] = snapshot.videos.flatMap((video) => {
        const releaseDate = new Date(video.launchDate).toISOString().slice(0, 10);
        if (releaseDate < windowStart || releaseDate > ctx.now.toISOString().slice(0, 10))
          return [];
        const releaseUrl = `https://www.manyvids.com/Video/${video.id}/${encodeURIComponent(video.slug)}/`;
        return [
          {
            sourceSceneId: video.id,
            title: video.title,
            releaseDate,
            durationSec: durationSeconds(video.duration),
            performers: [],
            storeId,
            launchDate: video.launchDate,
            price: video.price,
            thumbnailUrl: video.thumbnail?.url ?? "",
            previewUrl: video.preview?.url,
            releaseUrl,
            tags: video.tags ?? [],
            provenance: {
              source: "ManyVids",
              sourceUrl: base,
              recordUrl: releaseUrl,
              sourceSceneId: video.id,
            },
            fieldProvenance: Object.fromEntries(
              [
                "title",
                "releaseDate",
                "durationSec",
                "thumbnailUrl",
                "previewUrl",
                "price",
                "launchDate",
              ].map((field) => [field, "ManyVids"]),
            ),
          },
        ];
      });
      const encoded = JSON.stringify(snapshot);
      if (store) store.setSourceSnapshot(id, encoded);
      else memory = encoded;
      return { scenes, verifiedEmpty: scenes.length === 0 };
    },
  };
}
