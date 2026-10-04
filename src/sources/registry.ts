/**
 * The source registry. Adding a source is one entry here plus its adapter;
 * everything downstream (sync, matching, serving) reads this list.
 *
 * The source categories, in full:
 *
 *  1. traxxx.me  - Lancelot Styles Evolution, Mambo Perv, Woodman Casting X
 *                   (minus its XXXX scenes), plus the checked watchlist. No
 *                   auth; TPDB adds a separate authenticated watchlist lane.
 *  2. Direct URL scrape - Bang! Originals (verified parsers) and Maximo Garcia
 *                   (traxxx measures no scenes for it; listing is configured).
 *  3. fc2cmadb.com - the FC2 anal-tag lane. Its listing is cursor-paginated
 *                   Inertia HTML, its detail pages are paced at 8-9 seconds, and
 *                   its candidates' decisions live in `fc2_candidates` so a sync
 *                   never repays a detail request it already made.
 *  4. madouqu.com - eleven category ids, Mandarin classifier, metadata only.
 *  5. ManyVids - public creator store listings, incremental plus weekly full pulls.
 *  6. TPDB - one shared token, exact cleaned-name studio matching.
 */
import { createManyVidsSource } from "./manyvids.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
import { createTraxxxWatchlistStudios, parseTraxxxListingUrl } from "./traxxx-watchlist.ts";
import { createBangOriginalsStudio } from "./bang-originals.ts";
import { createFc2CmadbStudio, FC2CMADB_ID, type Fc2StudioOptions } from "./fc2cmadb.ts";
import { createMaximoGarciaStudio } from "./maximo-garcia.ts";
import { createMadouquStudio, MADOUQU_ID } from "./madouqu.ts";
import { createWoodmanCastingXSource } from "./woodman-casting-x.ts";
import type { SourceAdapter } from "./types.ts";
import { createTpdbWatchlistSource, type TpdbStudio } from "./tpdb-watchlist.ts";

export const RETIRED_SOURCE_IDS: readonly string[] = Object.freeze([
  "tushy",
  "lancelot-styles-evolution",
  "mambo-perv",
]);

/**
 * The Asian-language lanes, listed here because the dashboard splits them onto
 * their own catalogue page (#65). Membership is a presentation fact about a
 * source, so it belongs beside the adapters rather than in a UI string list
 * that would silently drift from a renamed id.
 */
export const ASIAN_SOURCE_IDS: readonly string[] = Object.freeze([FC2CMADB_ID, MADOUQU_ID]);

const TPDB_STUDIO_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  julesjordan: ["Jules Jordan"],
  mikeadriano: ["Mike Adriano"],
  teamskeet: ["Team Skeet"],
  firstanalquest: ["First Anal Quest"],
});
const MANYVIDS_STUDIO_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "1003095958": "Maximo Garcia",
  "1008105753": "Filou Fitt",
});

export interface RegistryOptions {
  madouquApiBase: string;
  traxxxWatchlist: readonly string[];
  /**
   * The store, used only by the FC2 lane to remember its candidate decisions.
   * Optional so a caller that has no database - a test, a CLI probe - still gets
   * a working registry; the FC2 lane then runs correctly but re-derives every
   * accepted record on every sync.
   */
  store?: SqliteStore;
  /** FC2 pacing and bounds, forwarded from configuration. */
  fc2?: Fc2StudioOptions;
  manyvidsStoreIds?: readonly string[];
  manyvidsMinIntervalMs?: number;
  /** Undefined leaves the Maximo Garcia lane reporting "not configured". */
  maximoListingUrl?: string | undefined;
  /** Hosts the Maximo listing and its video pages may live on. */
  maximoAllowedHosts?: readonly string[];
  tpdbApiKey?: string;
}

/** The complete set of adapters run by the sync, in a stable order. */
export function createSources({
  madouquApiBase,
  traxxxWatchlist,
  store,
  fc2 = {},
  maximoListingUrl,
  manyvidsStoreIds = ["1003095958"],
  manyvidsMinIntervalMs = 400,
  maximoAllowedHosts = [
    "sexlikereal.com",
    "www.sexlikereal.com",
    "analvids.com",
    "www.analvids.com",
  ],
  tpdbApiKey,
}: RegistryOptions): SourceAdapter[] {
  const sources = [
    createMaximoGarciaStudio(maximoListingUrl, maximoAllowedHosts),
    ...[...new Set(manyvidsStoreIds)].map((storeId) =>
      createManyVidsSource({ storeId, store, minIntervalMs: manyvidsMinIntervalMs }),
    ),
    createBangOriginalsStudio(),
    createFc2CmadbStudio({ ...fc2, store }),
    createMadouquStudio({ apiBase: madouquApiBase }),
  ];
  const watchlist = createTraxxxWatchlistStudios(traxxxWatchlist, [
    ...sources.map((source) => source.id),
    ...RETIRED_SOURCE_IDS,
  ]);
  sources.splice(2, 0, ...watchlist, createWoodmanCastingXSource());
  const studios: TpdbStudio[] = [
    ...watchlist.map((source) => {
      const lane = traxxxWatchlist
        .map(parseTraxxxListingUrl)
        .find((spec) => spec.id === source.id)!;
      return {
        studioId: source.id,
        studio: source.name,
        aliases: [source.name, source.id, ...(TPDB_STUDIO_ALIASES[lane.slug] ?? [])],
        tags: lane.tags,
      };
    }),
    ...[...new Set(manyvidsStoreIds)].flatMap((storeId) => {
      const name = MANYVIDS_STUDIO_NAMES[storeId] ?? `ManyVids store ${storeId}`;
      return [
        {
          studioId: `manyvids-${storeId}`,
          studio: name,
          aliases: MANYVIDS_STUDIO_NAMES[storeId] ? [name] : [],
        },
      ];
    }),
  ];
  sources.push(createTpdbWatchlistSource({ token: tpdbApiKey, studios }));
  return sources;
}
