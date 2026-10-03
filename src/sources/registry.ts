/**
 * The source registry. Adding a source is one entry here plus its adapter;
 * everything downstream (sync, matching, serving) reads this list.
 *
 * The five categories, in full:
 *
 *  1. traxxx.me  - Lancelot Styles Evolution, Mambo Perv, Woodman Casting X
 *                   (minus its XXXX scenes), plus the checked watchlist. No
 *                   auth, and traxxx replaced TPDB entirely.
 *  2. Direct URL scrape - Bang! Originals (verified parsers) and Maximo Garcia
 *                   (traxxx measures no scenes for it; listing is configured).
 *  3. fc2cmadb.com - the FC2 anal-tag lane. Its listing is cursor-paginated
 *                   Inertia HTML, its detail pages are paced at 8-9 seconds, and
 *                   its candidates' decisions live in `fc2_candidates` so a sync
 *                   never repays a detail request it already made.
 *  4. madouqu.com - eleven category ids, Mandarin classifier, metadata only.
 *  5. ManyVids - public creator store listings, incremental plus weekly full pulls.
 */
import { createManyVidsSource } from "./manyvids.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
import { createTraxxxStudio } from "./traxxx.ts";
import { createTraxxxWatchlistStudios } from "./traxxx-watchlist.ts";
import { createBangOriginalsStudio } from "./bang-originals.ts";
import { createFc2CmadbStudio, FC2CMADB_ID } from "./fc2cmadb.ts";
import { createMaximoGarciaStudio } from "./maximo-garcia.ts";
import { createMadouquStudio, MADOUQU_ID } from "./madouqu.ts";
import type { Fc2StudioOptions } from "./fc2cmadb.ts";
import { createWoodmanCastingXSource } from "./woodman-casting-x.ts";
import type { SourceAdapter } from "./types.ts";

export const lancelotStylesEvolution = createTraxxxStudio({
  id: "lancelot-styles-evolution",
  name: "Lancelot Styles Evolution",
  kind: "channel",
  slug: "lancelotstyles",
});

export const mamboPerv = createTraxxxStudio({
  id: "mambo-perv",
  name: "Mambo Perv",
  kind: "channel",
  slug: "mamboperv",
});

export const RETIRED_SOURCE_IDS: readonly string[] = Object.freeze(["tushy"]);

/**
 * The Asian-language lanes, listed here because the dashboard splits them onto
 * their own catalogue page (#65). Membership is a presentation fact about a
 * source, so it belongs beside the adapters rather than in a UI string list
 * that would silently drift from a renamed id.
 */
export const ASIAN_SOURCE_IDS: readonly string[] = Object.freeze([FC2CMADB_ID, MADOUQU_ID]);

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
}: RegistryOptions): SourceAdapter[] {
  const sources = [
    lancelotStylesEvolution,
    mamboPerv,
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
  return sources;
}
