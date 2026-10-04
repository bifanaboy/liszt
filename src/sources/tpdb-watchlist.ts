import { z } from "zod";
import { FetchError } from "../core/fetcher.ts";
import type { RawScene, SourceAdapter, SourceContext } from "./types.ts";

const Meta = z.object({
  current_page: z.number().int().positive(),
  /** TPDB names the final page `last_page`; `last` is not a field it returns. */
  last_page: z.number().int().nonnegative(),
});
const Site = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  short_name: z.string().optional(),
});
const SiteEnvelope = z.object({ data: Site });
type TpdbSite = z.infer<typeof Site>;
const ScenePage = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().trim().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      duration: z.number().int().positive().nullable().optional(),
      url: z.string().url().nullable().optional(),
      image: z.string().url().nullable().optional(),
      poster: z.string().url().nullable().optional(),
      performers: z.array(z.object({ name: z.string().min(1) })).optional(),
      tags: z.array(z.object({ name: z.string().min(1) })).optional(),
      site: z.object({ name: z.string().min(1) }).optional(),
    }),
  ),
  meta: Meta,
});

const MAX_PAGES = 1000;
const BASE = "https://api.theporndb.net";
const MIN_INTERVAL_MS = 250;

export interface TpdbStudio {
  studioId: string;
  studio: string;
  aliases: readonly string[];
  tags?: readonly string[];
}

export function cleanStudioName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A site lookup by identifier, for the names TPDB accepts in place of an id. */
async function fetchSite(
  ctx: SourceContext,
  identifier: string,
  token: string,
): Promise<TpdbSite | undefined> {
  const url = new URL(`/sites/${encodeURIComponent(identifier)}`, BASE);
  try {
    const raw = await ctx.fetcher.json(url.href, { headers: { Authorization: `Bearer ${token}` } });
    return SiteEnvelope.parse(raw).data;
  } catch (error) {
    // Only an ABSENT studio is tolerated. A timeout, a 500 or a malformed body
    // means the lookup did not actually answer, and treating that as "this
    // studio is not in TPDB" would quietly shrink the lane to whatever happened
    // to succeed - the failure has to propagate instead.
    if (error instanceof FetchError && error.kind === "definitive") return undefined;
    throw error;
  }
}

function checkedPage<T extends { meta: { current_page: number; last_page: number } }>(
  page: T,
  current: number,
  label: string,
): T {
  if (
    page.meta.current_page !== current ||
    page.meta.last_page > MAX_PAGES ||
    (page.meta.last_page < current && !(current === 1 && page.meta.last_page === 0))
  ) {
    throw new Error(`TPDB ${label}: inconsistent pagination on page ${current}`);
  }
  return page;
}

async function* pages<T extends { meta: { current_page: number; last_page: number } }>(
  ctx: SourceContext,
  path: string,
  token: string,
  parse: (value: unknown) => T,
  label: string,
): AsyncGenerator<T> {
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) throw new Error(`TPDB ${label}: pagination exceeded ${MAX_PAGES} pages`);
    const url = new URL(path, BASE);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const raw = await ctx.fetcher.json(url.href, { headers: { Authorization: `Bearer ${token}` } });
    const data = checkedPage(parse(raw), page, label);
    yield data;
    if (page >= data.meta.last_page) return;
  }
}

export function createTpdbWatchlistSource(options: {
  token?: string;
  studios: readonly TpdbStudio[];
}): SourceAdapter {
  const cachedSites = new Map<number, TpdbStudio | null>();
  const aliases = new Map<string, TpdbStudio | null>();
  for (const studio of options.studios)
    for (const alias of studio.aliases) {
      const key = cleanStudioName(alias);
      if (!key) continue;
      const prior = aliases.get(key);
      aliases.set(
        key,
        prior === null || (prior && prior.studioId !== studio.studioId) ? null : studio,
      );
    }
  return {
    id: "tpdb-watchlist",
    name: "TPDB watchlist",
    authority: { name: "ThePornDB", url: BASE, role: "Studio release catalogue" },
    matcher: "sxyprn+eporner",
    async fetch(windowStart, ctx) {
      const token = options.token;
      if (!token) throw new Error("TPDB token missing; set TPDB_API_KEY in the server environment");
      let lastRequestAt = 0;
      const fetchJson = async <T = unknown>(url: string): Promise<T> => {
        const wait = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastRequestAt = Date.now();
        return ctx.fetcher.json<T>(url, { headers: { Authorization: `Bearer ${token}` } });
      };
      const pacedCtx = { ...ctx, fetcher: { ...ctx.fetcher, json: fetchJson } };
      // Resolve each configured studio with one direct lookup rather than
      // paginating the whole /sites catalogue. That catalogue is ~104k rows
      // (1042 pages at the API's 100-row cap), which is both slower than 18
      // lookups and past MAX_PAGES, so the walk could not complete at all.
      if (!cachedSites.size) {
        for (const studio of options.studios) {
          if (studio.aliases.every((alias) => !cleanStudioName(alias))) continue;
          for (const alias of studio.aliases) {
            const key = cleanStudioName(alias);
            if (!key || aliases.get(key) !== studio) continue;
            const site = await fetchSite(pacedCtx, key, token);
            if (!site) continue;
            // Only accept a site whose own name or short name is an alias of
            // this studio. /sites/{identifier} resolves loosely (a slug may
            // return a different site), so the response is verified rather
            // than trusted.
            const siteKeys = [cleanStudioName(site.name), cleanStudioName(site.short_name ?? "")];
            if (!siteKeys.some((candidate) => aliases.get(candidate) === studio)) continue;
            cachedSites.set(site.id, studio);
            break;
          }
        }
      }
      const sites = cachedSites;
      const scenes: RawScene[] = [];
      for (const [siteId, studio] of sites) {
        if (!studio) continue;
        for await (const page of pages(
          pacedCtx,
          `/scenes?site_id=${siteId}&date=${encodeURIComponent(windowStart)}&date_operation=%3E%3D`,
          token,
          (raw) => ScenePage.parse(raw),
          `site(${siteId})`,
        )) {
          for (const scene of page.data) {
            if (scene.date < windowStart || scene.date > ctx.now.toISOString().slice(0, 10))
              continue;
            const sceneTags = new Set((scene.tags ?? []).map((tag) => cleanStudioName(tag.name)));
            if (!(studio.tags ?? []).every((tag) => sceneTags.has(cleanStudioName(tag)))) continue;
            const recordUrl = scene.url ?? undefined;
            scenes.push({
              sourceSceneId: scene.id,
              studioId: studio.studioId,
              studio: studio.studio,
              title: scene.title,
              releaseDate: scene.date,
              durationSec: scene.duration ?? null,
              performers: scene.performers?.map((person) => person.name) ?? [],
              thumbnailUrl: scene.image ?? scene.poster ?? "",
              ...(recordUrl ? { releaseUrl: recordUrl } : {}),
              provenance: {
                source: "TPDB",
                sourceUrl: BASE,
                ...(recordUrl ? { recordUrl } : {}),
                sourceSceneId: scene.id,
              },
              fieldProvenance: {
                title: "TPDB",
                releaseDate: "TPDB",
                ...(scene.duration ? { durationSec: "TPDB" } : {}),
                ...(scene.image || scene.poster ? { thumbnailUrl: "TPDB" } : {}),
              },
            });
          }
        }
      }
      const matched = [...sites.values()].filter((studio): studio is TpdbStudio => studio !== null);
      const matchedStudioIds = new Set(matched.map((studio) => studio.studioId));
      const unmatchedStudios = [
        ...new Set(options.studios.map((studio) => studio.studioId)),
      ].filter((studioId) => !matchedStudioIds.has(studioId));
      ctx.log("TPDB watchlist fetched", {
        studios: matched.length,
        scenes: scenes.length,
        unmatchedStudios,
      });
      if (!matched.length) throw new Error("TPDB watchlist matched no configured studio names");
      return { scenes, verifiedEmpty: scenes.length === 0 };
    },
  };
}
