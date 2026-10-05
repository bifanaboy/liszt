/** Bang! Originals JSON-LD adapter. */
import { z } from "zod";
import type { RawScene, SourceAdapter, SourceContext } from "./types.ts";

const HOST = "www.bang.com";
const Listing = z.object({
  "@type": z.union([z.literal("SearchResultsPage"), z.array(z.string())]),
  mainEntity: z.object({ itemListElement: z.array(z.unknown()) }),
});
const Video = z.object({
  "@type": z.union([z.literal("VideoObject"), z.array(z.string())]),
  name: z.string().trim().min(1),
  thumbnailUrl: z.string().url(),
  datePublished: z.string().min(10),
  duration: z
    .string()
    .regex(/^PT(?:(?:\d+)H)?(?:(?:\d+)M)?(?:(?:\d+)S)?$/)
    .refine((value) => seconds(value) > 0, "duration must be positive"),
  productionCompany: z.object({ name: z.string().min(1) }),
});
const PAGE_LIMIT = 20;

function blocks(html: string): unknown[] {
  const values: unknown[] = [];
  for (const match of html.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      values.push(JSON.parse(match[1]!.trim()));
    } catch {
      throw new Error("Bang listing contains malformed JSON-LD");
    }
  }
  return values;
}

function find(value: unknown, kind: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = find(item, kind);
      if (found) return found;
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      record["@type"] === kind ||
      (Array.isArray(record["@type"]) && record["@type"].includes(kind))
    ) {
      return record;
    }
    for (const child of Object.values(record)) {
      const found = find(child, kind);
      if (found) return found;
    }
  }
  return undefined;
}

function links(html: string): string[] {
  const page = find(blocks(html), "SearchResultsPage");
  const parsed = Listing.safeParse(page);
  if (!parsed.success) throw new Error("Bang listing is missing SearchResultsPage items");
  const output: string[] = [];
  for (const item of parsed.data.mainEntity.itemListElement) {
    const entry = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const detail =
      entry.item && typeof entry.item === "object"
        ? (entry.item as Record<string, unknown>).url
        : entry.url;
    if (typeof detail === "string") output.push(detail);
  }
  return output;
}

function nextPage(html: string, current: string): string | null {
  const currentPage = Number(new URL(current).searchParams.get("page") ?? 1);
  const candidates: string[] = [];
  for (const match of html.matchAll(/href=["']([^"']*page=\d+[^"']*)["']/gi)) {
    const href = match[1]!.replace(/&amp;/gi, "&");
    const next = new URL(href, current);
    if (next.hostname.toLowerCase() !== HOST || next.pathname !== "/videos") {
      throw new Error("Bang listing pagination points outside www.bang.com/videos");
    }
    if (Number(next.searchParams.get("page")) > currentPage) candidates.push(next.href);
  }
  return (
    candidates.sort(
      (left, right) =>
        Number(new URL(left).searchParams.get("page")) -
        Number(new URL(right).searchParams.get("page")),
    )[0] ?? null
  );
}

function seconds(duration: string): number {
  const hours = Number(duration.match(/(\d+)H/)?.[1] ?? 0);
  const minutes = Number(duration.match(/(\d+)M/)?.[1] ?? 0);
  const seconds = Number(duration.match(/(\d+)S/)?.[1] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function record(html: string, url: string, today: string): RawScene | null {
  const video = Video.safeParse(find(blocks(html), "VideoObject"));
  if (!video.success) throw new Error(`Bang detail page has invalid VideoObject: ${url}`);
  if (video.data.productionCompany.name.trim().toLowerCase() !== "bang! originals") return null;
  const date = video.data.datePublished.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Bang has invalid release date: ${url}`);
  if (date > today) return null;
  const path = new URL(url).pathname.split("/").filter(Boolean);
  const identifier = path[1];
  if (!identifier) throw new Error(`Bang detail URL has no video identifier: ${url}`);
  return {
    sourceSceneId: identifier,
    title: video.data.name,
    releaseDate: date,
    performers: [],
    durationSec: seconds(video.data.duration),
    thumbnailUrl: video.data.thumbnailUrl,
    releaseUrl: url,
    studioId: "bang-originals",
    studio: "Bang! Originals",
    provenance: {
      source: "Bang! Originals",
      sourceUrl: "https://www.bang.com/videos?by=date.desc",
      recordUrl: url,
      sourceSceneId: identifier,
    },
    fieldProvenance: {
      title: "Bang! Originals",
      releaseDate: "Bang! Originals",
      durationSec: "Bang! Originals",
      thumbnailUrl: "Bang! Originals",
    },
  };
}

export function createBangOriginalsStudio(listingUrl?: string): SourceAdapter {
  return {
    id: "bang-originals",
    name: "Bang Originals",
    authority: {
      name: "Bang! Originals",
      url: "https://www.bang.com",
      role: "Studio release listing",
    },
    matcher: "sxyprn+eporner",
    async fetch(windowStart: string, ctx: SourceContext) {
      if (!listingUrl) throw new Error("Bang Originals listing URL is not configured");
      const base = new URL(listingUrl);
      if (base.hostname.toLowerCase() !== HOST || base.pathname !== "/videos") {
        throw new Error("Bang listing must be a www.bang.com/videos URL");
      }
      const today = ctx.now.toISOString().slice(0, 10);
      const scenes: RawScene[] = [];
      let current: string | null = base.href;
      let pages = 0;
      while (current) {
        if (++pages > PAGE_LIMIT) throw new Error(`Bang listing exceeded ${PAGE_LIMIT} pages`);
        const html = await ctx.fetcher.text(current);
        const urls = links(html).map((href) => {
          const target = new URL(href, current!);
          if (target.hostname.toLowerCase() !== HOST || !target.pathname.startsWith("/video/")) {
            throw new Error("Bang listing contains a video URL outside www.bang.com");
          }
          return target.href;
        });
        const found = await ctx.mapIsolated(urls, async (url) =>
          record(await ctx.fetcher.text(url), url, today),
        );
        scenes.push(
          ...found.filter((scene): scene is RawScene =>
            Boolean(scene && scene.releaseDate >= windowStart && scene.releaseDate <= today),
          ),
        );
        const dates = found
          .map((scene) => scene?.releaseDate)
          .filter((date): date is string => Boolean(date));
        if (dates.length && dates.every((date) => date < windowStart)) break;
        current = nextPage(html, current);
      }
      return { scenes, verifiedEmpty: scenes.length === 0 };
    },
  };
}
