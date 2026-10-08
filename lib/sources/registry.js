import { createManyVidsSource } from "./manyvids.js";
import { createTraxxxWatchlistStudios } from "./traxxx-watchlist.js";
import { createBangOriginalsStudio } from "./bang-originals.js";
import { createFc2CmadbStudio, FC2CMADB_ID } from "./fc2cmadb.js";
import { createMaximoGarciaStudio } from "./maximo-garcia.js";
import { createMadouquStudio, MADOUQU_ID } from "./madouqu.js";
import { createWoodmanCastingXSource } from "./woodman-casting-x.js";
import { createTpdbWatchlistSource } from "./tpdb-watchlist.js";
import { TPDB_ANAL_SITE_IDS } from "./tpdb-anal-watchlist.js";
import { applyStudioPolicy } from "./studio-policy.js";
export const RETIRED_SOURCE_IDS = Object.freeze([
  "tushy",
  "lancelot-styles-evolution",
  "mambo-perv",
]);
export const ASIAN_SOURCE_IDS = Object.freeze([FC2CMADB_ID, MADOUQU_ID]);
function registerFeed(source, url, studioPolicy) {
  const definition = {
    adapterId: source.id,
    sourceUrl: url,
    studioPolicy,
  };
  return applyStudioPolicy(source, definition);
}
export function createSources({
  madouquApiBase,
  traxxxWatchlist,
  store,
  fc2 = {},
  bangListingUrl = "https://www.bang.com/videos?by=date.desc",
  manyvidsStoreIds = ["1003095958"],
  manyvidsMinIntervalMs = 400,
  tpdbApiKey,
  studioLinks = [],
}) {
  const maximoPolicy = {
    mode: "umbrella",
    studioId: "maximo-garcia",
    studio: "Maximo Garcia",
  };
  const sources = [
    registerFeed(createMaximoGarciaStudio(), "https://fansly.com/maximo_garcia", maximoPolicy),
    ...[...new Set(manyvidsStoreIds)].map((storeId) =>
      registerFeed(
        createManyVidsSource({ storeId, store, minIntervalMs: manyvidsMinIntervalMs }),
        `https://www.manyvids.com/bff/store/videos/${storeId}/`,
        storeId === "1003095958" ? maximoPolicy : { mode: "split" },
      ),
    ),
    registerFeed(createBangOriginalsStudio(bangListingUrl), bangListingUrl, { mode: "split" }),
    createFc2CmadbStudio({ ...fc2, store }),
    createMadouquStudio({ apiBase: madouquApiBase }),
  ];
  const watchlist = createTraxxxWatchlistStudios(traxxxWatchlist, [
    ...sources.map((source) => source.id),
    ...RETIRED_SOURCE_IDS,
  ]);
  sources.splice(2, 0, ...watchlist, createWoodmanCastingXSource());
  const tpdbAnalSiteIds = new Set(TPDB_ANAL_SITE_IDS);
  const linkedTpdbSiteIds = new Set(studioLinks.flatMap((link) => link.tpdb?.siteIds ?? []));
  const tpdbStudios = [
    ...TPDB_ANAL_SITE_IDS.filter((siteId) => !linkedTpdbSiteIds.has(siteId)).map((siteId) => ({
      studioId: `tpdb-${siteId}~anal`,
      studio: `TPDB site ${siteId}`,
      aliases: [],
      siteIds: [siteId],
      tags: ["anal"],
      useSiteName: true,
    })),
    ...watchlist.map((source) => ({
      studioId: source.id,
      studio: source.name,
      aliases: [source.name, source.id],
    })),
  ];
  if (tpdbApiKey) {
    const linked = studioLinks.some(
      (link) =>
        link.studio.toLowerCase() === "maximo garcia" ||
        link.aliases?.some((alias) => alias.toLowerCase() === "maximo garcia"),
    );
    const stores = [...new Set(manyvidsStoreIds)].filter(
      (storeId) => storeId !== "1003095958" || !linked,
    );
    tpdbStudios.push(
      ...stores.map((storeId) => ({
        studioId: storeId === "1003095958" ? "maximo-garcia" : `manyvids-${storeId}`,
        studio: storeId === "1003095958" ? "Maximo Garcia" : `ManyVids store ${storeId}`,
        aliases: [storeId === "1003095958" ? "Maximo Garcia" : `ManyVids store ${storeId}`],
      })),
    );
  }
  tpdbStudios.push(
    ...studioLinks
      .filter((link) => link.tpdb)
      .flatMap((link) => {
        const analSiteIds = link.tpdb.siteIds.filter((siteId) => tpdbAnalSiteIds.has(siteId));
        const studio = {
          studioId: link.studioId,
          studio: link.studio,
          aliases: [link.studio, ...(link.aliases ?? []), link.tpdb.name],
          siteIds: link.tpdb.siteIds.filter((siteId) => !tpdbAnalSiteIds.has(siteId)),
          ...(link.tags?.length ? { tags: link.tags } : {}),
        };
        return [
          studio,
          ...(analSiteIds.length
            ? [
                {
                  ...studio,
                  aliases: [],
                  siteIds: analSiteIds,
                  tags: [...new Set([...(link.tags ?? []), "anal"])],
                },
              ]
            : []),
        ];
      }),
  );
  if (tpdbApiKey) {
    sources.push(createTpdbWatchlistSource({ token: tpdbApiKey, studios: tpdbStudios }));
  }
  return sources;
}
