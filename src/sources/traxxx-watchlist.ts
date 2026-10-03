import type { SourceAdapter } from "./types.ts";
import { createTraxxxStudio, type TraxxxEntityKind } from "./traxxx.ts";
import { WOODMAN_CASTING_X_SLUG } from "./woodman-casting-x.ts";

export interface TraxxxLaneSpec {
  id: string;
  kind: TraxxxEntityKind;
  slug: string;
  tags: string[];
  url: string;
}

export const TRAXXX_WATCHLIST: readonly string[] = Object.freeze([
  "https://traxxx.me/network/vixen/scenes/latest/1?tags=anal",
]);

export function parseTraxxxListingUrl(raw: string): TraxxxLaneSpec {
  const invalid = (reason: string): never => {
    throw new Error(`Invalid Traxxx watchlist URL ${raw}: ${reason}`);
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid("not a URL");
  }
  if (url.protocol !== "https:") invalid("must use HTTPS");
  if (url.hostname !== "traxxx.me" && url.hostname !== "www.traxxx.me") {
    invalid("unsupported host");
  }
  const match = url.pathname.match(
    /^\/(network|channel)\/([a-z0-9-]+)\/scenes\/(latest)\/(\d+)\/?$/i,
  );
  if (!match) return invalid("expected /network|channel/<slug>/scenes/latest/1");
  const [, kindText, slugText, sort, page] = match;
  if (sort !== "latest") invalid("sort must be latest");
  if (page !== "1") invalid("page must be 1");
  for (const key of url.searchParams.keys()) {
    if (key !== "tags") invalid(`unsupported query parameter "${key}"`);
  }
  const tagsValue = url.searchParams.get("tags");
  const tags =
    tagsValue === null
      ? []
      : tagsValue
          .split(",")
          .map((tag) => tag.trim().toLowerCase())
          .filter(Boolean)
          .sort();
  if (tagsValue !== null && (!tags.length || tags.some((tag) => !/^[a-z0-9-]+$/.test(tag)))) {
    invalid("tags must contain non-empty slugs");
  }
  const kind = kindText!.toLowerCase() as TraxxxEntityKind;
  const slug = slugText!.toLowerCase();
  const canonical = new URL(url.origin);
  canonical.pathname = `/${kind}/${slug}/scenes/latest/1`;
  if (tags.length) canonical.searchParams.set("tags", tags.join(","));
  return {
    id: [kind, slug, ...tags].join("-"),
    kind,
    slug,
    tags,
    url: canonical.href,
  };
}

export function createTraxxxLaneIds(urls: readonly string[]): string[] {
  return urls.map((url) => parseTraxxxListingUrl(url).id);
}

function displayName(value: string): string {
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

export function createTraxxxWatchlistStudios(
  urls: readonly string[],
  reservedIds: readonly string[] = [],
): SourceAdapter[] {
  const specs = urls.map(parseTraxxxListingUrl);
  const seen = new Set<string>();
  const reserved = new Set(reservedIds);
  for (const spec of specs) {
    if (spec.kind === "channel" && spec.slug === WOODMAN_CASTING_X_SLUG) {
      throw new Error(`Reserved Traxxx watchlist channel "${spec.slug}" for ${spec.url}`);
    }
    if (reserved.has(spec.id)) {
      throw new Error(`Reserved Traxxx watchlist ID "${spec.id}" for ${spec.url}`);
    }
    if (seen.has(spec.id)) {
      throw new Error(`Duplicate Traxxx watchlist ID "${spec.id}" for ${spec.url}`);
    }
    seen.add(spec.id);
  }
  return specs.map((spec) => {
    return createTraxxxStudio({
      id: spec.id,
      name: displayName(spec.slug),
      kind: spec.kind,
      slug: spec.slug,
      tags: spec.tags,
    });
  });
}
