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
 *  3. fc2cmadb.com - a named stub. Its interface is unconfirmed.
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
  manyvidsStoreIds?: readonly string[];
  manyvidsMinIntervalMs?: number;
  store?: SqliteStore;
  /** Undefined leaves the Maximo Garcia lane reporting "not configured". */
  maximoListingUrl?: string | undefined;
  /** Hosts the Maximo listing and its video pages may live on. */
  maximoAllowedHosts?: readonly string[];
}

/** The complete set of adapters run by the sync, in a stable order. */
export function createSources({
  madouquApiBase,
  traxxxWatchlist,
  maximoListingUrl,
  manyvidsStoreIds = ["1003095958"],
  manyvidsMinIntervalMs = 400,
  store,
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
    createFc2CmadbStudio(),
    createMadouquStudio({ apiBase: madouquApiBase }),
  ];
  const watchlist = createTraxxxWatchlistStudios(traxxxWatchlist, [
    ...sources.map((source) => source.id),
    ...RETIRED_SOURCE_IDS,
  ]);
  sources.splice(2, 0, ...watchlist, createWoodmanCastingXSource());
  return sources;
}
