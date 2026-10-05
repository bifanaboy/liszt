/** The source registry. Adding a source is one entry here plus its adapter;
 * everything downstream (sync, matching, serving) reads this list.
 *
 * The source categories, in full:
 *
 *  1. traxxx.me  - Lancelot Styles Evolution, Mambo Perv, Woodman Casting X
 *                  (minus its XXXX scenes), plus the checked watchlist. No
 *                  auth; TPDB adds a separate authenticated watchlist lane.
 *  2. Direct URL scrape - Bang! Originals (verified parsers) and Maximo Garcia
 *                  (traxxx measures no scenes for it; listing is configured).
 *  3. fc2cmadb.com - the FC2 anal-tag lane. Its listing is cursor-paginated
 *                  Inertia HTML, its detail pages are paced at 8-9 seconds, and
 *                  its candidates' decisions live in `fc2_candidates` so a sync
 *                  never repays a detail request it already made.
 *  4. madouqu.com - eleven category ids, Mandarin classifier, metadata only.
 *  5. ManyVids - public creator store listings, incremental plus weekly full pulls.
 *  6. TPDB - one shared token, exact cleaned-name studio matching.
 */
import { createManyVidsSource } from "./manyvids.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
import { createTraxxxWatchlistStudios } from "./traxxx-watchlist.ts";
import { createBangOriginalsStudio } from "./bang-originals.ts";
import { createFc2CmadbStudio, FC2CMADB_ID, type Fc2StudioOptions } from "./fc2cmadb.ts";
import { createMaximoGarciaStudio } from "./maximo-garcia.ts";
import { createMadouquStudio, MADOUQU_ID } from "./madouqu.ts";
import { createWoodmanCastingXSource } from "./woodman-casting-x.ts";
import type { FeedDefinition, SourceAdapter, StudioPolicy } from "./types.ts";
import { createTpdbWatchlistSource, type TpdbStudio } from "./tpdb-watchlist.ts";
import { TPDB_ANAL_SITE_IDS } from "./tpdb-anal-watchlist.ts";
import type { StudioLink } from "./studio-identity.ts";
import { applyStudioPolicy } from "./studio-policy.ts";

export const RETIRED_SOURCE_IDS: readonly string[] = Object.freeze([
  "tushy",
  "lancelot-styles-evolution",
  "mambo-perv",
]);

/** The Asian-language lanes, listed here because the dashboard splits them onto
 * their own catalogue page (#65). Membership is a presentation fact about a
 * source, so it belongs beside the adapters rather than in a UI string list
 * that would silently drift from a renamed id.
 */
export const ASIAN_SOURCE_IDS: readonly string[] = Object.freeze([FC2CMADB_ID, MADOUQU_ID]);

export interface RegistryOptions {
  madouquApiBase: string;
  traxxxWatchlist: readonly string[];
  /** The store, used only by the FC2 lane to remember its candidate decisions.
   * Optional so a caller that has no database - a test, a CLI probe - still gets
   * a working registry; the FC2 lane then runs correctly but re-derives every
   * accepted record on every sync.
   */
  store?: SqliteStore;
  /** FC2 pacing and bounds, forwarded from configuration. */
  fc2?: Fc2StudioOptions;
  manyvidsStoreIds?: readonly string[];
  manyvidsMinIntervalMs?: number;
  /** Configured listing URL for Bang! Originals (single URL composite feed). */
  bangListingUrl?: string | undefined;
  /** TPDB API key. When omitted the TPDB watchlist lane is skipped rather than
   * failing every cycle, following the SETUP REQUIRED pattern. */
  tpdbApiKey?: string;
  studioLinks?: readonly StudioLink[];
}

function registerFeed(
  source: SourceAdapter,
  url: string,
  studioPolicy: StudioPolicy,
): SourceAdapter {
  const definition: FeedDefinition = {
    adapterId: source.id,
    sourceUrl: url,
    studioPolicy,
  };
  return applyStudioPolicy(source, definition);
}

/** The complete set of adapters run by the sync, in a stable order. */
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
}: RegistryOptions): SourceAdapter[] {
  const maximoPolicy = {
    mode: "umbrella" as const,
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

  // Build the TPDB studio alias map from watchlist and ManyVids sources.
  // ManyVids synthetic aliases (manyvids-<id>) are excluded from TPDB matching
  // because they can never match a TPDB site name — they are silently inert
  // (issue: synthetic aliases create false collision opportunities). Only
  // unambiguous TPDB-derived aliases and the watchlist sources themselves
  // participate in studio matching.
  const tpdbAnalSiteIds = new Set(TPDB_ANAL_SITE_IDS);
  // Preserve an existing studio identity if its site is also in the new list.
  const linkedTpdbSiteIds = new Set(studioLinks.flatMap((link) => link.tpdb?.siteIds ?? []));
  const tpdbStudios: TpdbStudio[] = [
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
  // Only add ManyVids studio entries if a TPDB token is configured; this
  // prevents synthetic manyvids aliases from contaminating the TPDB alias map
  // when TPDB is not set up (SETUP REQUIRED pattern).
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
      .map((link) => {
        const tags = [
          ...new Set([
            ...(link.tags ?? []),
            ...(link.tpdb!.siteIds.some((siteId) => tpdbAnalSiteIds.has(siteId)) ? ["anal"] : []),
          ]),
        ];
        return {
          studioId: link.studioId,
          studio: link.studio,
          aliases: [link.studio, ...(link.aliases ?? []), link.tpdb!.name],
          siteIds: link.tpdb!.siteIds,
          ...(tags.length ? { tags } : {}),
        };
      }),
  );

  if (tpdbApiKey) {
    sources.push(createTpdbWatchlistSource({ token: tpdbApiKey, studios: tpdbStudios }));
  }
  return sources;
}
