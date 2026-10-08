import { z } from "../validation.js";
import { isExcludedMaximoTitle } from "./maximo-garcia.js";
const Meta = z.object({
  current_page: z.number().int().positive(),
  last_page: z.number().int().nonnegative(),
});
const SitePage = z.object({
  data: z.array(
    z.object({
      id: z.number().int().positive(),
      name: z.string().min(1),
      short_name: z.string().optional(),
    }),
  ),
  meta: Meta,
});
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
export function cleanStudioName(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
function checkedPage(page, current, label) {
  if (
    page.meta.current_page !== current ||
    page.meta.last_page > MAX_PAGES ||
    (page.meta.last_page < current && !(current === 1 && page.meta.last_page === 0))
  ) {
    throw new Error(`TPDB ${label}: inconsistent pagination on page ${current}`);
  }
  return page;
}
async function* pages(ctx, path, token, parse, label) {
  for (let page = 1; ; page += 1) {
    if (page > MAX_PAGES) throw new Error(`TPDB ${label}: pagination exceeded ${MAX_PAGES} pages`);
    const url = new URL(path, BASE);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const raw = await ctx.fetcher.json(url.href, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = checkedPage(parse(raw), page, label);
    yield data;
    if (page >= data.meta.last_page) return;
  }
}
export function createTpdbWatchlistSource(options) {
  const aliases = new Map();
  for (const studio of options.studios)
    for (const alias of studio.aliases) {
      const key = cleanStudioName(alias);
      if (!key) continue;
      const prior = aliases.get(key);
      if (!aliases.has(key)) {
        aliases.set(key, studio);
      } else if (prior && prior.studioId !== studio.studioId) {
        aliases.set(key, null);
      }
    }
  return {
    id: "tpdb-watchlist",
    name: "TPDB watchlist",
    authority: { name: "ThePornDB", url: BASE, role: "Studio release catalogue" },
    matcher: "sxyprn+eporner",
    async fetch(windowStart, ctx) {
      const token = options.token;
      if (!token) throw new Error("TPDB token missing; set TPDB_API_KEY in the server environment");
      const sites = new Map();
      for await (const page of pages(ctx, "/sites", token, (raw) => SitePage.parse(raw), "sites")) {
        for (const site of page.data) {
          const configured = options.studios.find((studio) => studio.siteIds?.includes(site.id));
          const studioByName = aliases.get(cleanStudioName(site.name));
          if (!configured && studioByName === null) continue;
          let studio = configured ?? (studioByName || undefined);
          if (!studio && site.short_name) {
            const studioByShort = aliases.get(cleanStudioName(site.short_name));
            if (studioByShort === null) continue;
            studio = studioByShort;
          } else if (!configured && studio && site.short_name) {
            const studioByShort = aliases.get(cleanStudioName(site.short_name));
            if (
              studioByShort === null ||
              (studioByShort && studioByShort.studioId !== studio.studioId)
            )
              continue;
          }
          if (studio) {
            sites.set(site.id, studio.useSiteName ? { ...studio, studio: site.name } : studio);
          }
        }
      }
      const scenes = [];
      const excludedRecords = [];
      for (const [siteId, studio] of sites) {
        for await (const page of pages(
          ctx,
          `/scenes?site_id=${siteId}`,
          token,
          (raw) => ScenePage.parse(raw),
          `site(${siteId})`,
        )) {
          for (const scene of page.data) {
            if (scene.date < windowStart || scene.date > ctx.now.toISOString().slice(0, 10))
              continue;
            if (
              studio.tags?.length &&
              !studio.tags.every((tag) =>
                scene.tags?.some((item) => cleanStudioName(item.name) === cleanStudioName(tag)),
              )
            ) {
              continue;
            }
            if (
              ["maximo-garcia", "tpdb-maximogarcia"].includes(studio.studioId) ||
              cleanStudioName(studio.studio) === "maximogarcia"
            ) {
              if (isExcludedMaximoTitle(scene.title)) {
                excludedRecords.push({ providerId: `tpdb-site-${siteId}`, recordId: scene.id });
                continue;
              }
            }
            const recordUrl = scene.url ?? undefined;
            scenes.push({
              providerId: `tpdb-site-${siteId}`,
              providerStudioId: `tpdb-site-${siteId}`,
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
      ctx.log("TPDB watchlist fetched", { studios: sites.size, scenes: scenes.length });
      const verified = sites.size > 0 || scenes.length > 0;
      return {
        scenes,
        verifiedEmpty: verified,
        ...(excludedRecords.length ? { excludedRecords } : {}),
      };
    },
  };
}
