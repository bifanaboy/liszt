/**
 * The source registry. Adding a source is one entry here plus its adapter;
 * everything downstream (sync, matching, serving) reads this list.
 *
 * The four categories, in full:
 *
 *  1. traxxx.me  - Lancelot Styles Evolution, Mambo Perv, plus the checked
 *                   watchlist. No auth, and traxxx replaced TPDB entirely.
 *  2. Direct URL scrape - Bang! Originals (verified parsers) and Maximo Garcia
 *                   (traxxx measures no scenes for it; listing is configured).
 *  3. fc2cmadb.com - the FC2 anal-tag lane. Its listing is cursor-paginated
 *                   Inertia HTML, its detail pages are paced at 8-9 seconds, and
 *                   its candidates' decisions live in `fc2_candidates` so a sync
 *                   never repays a detail request it already made.
 *  4. madouqu.com - eleven category ids, Mandarin classifier, metadata only.
 */
import { createTraxxxStudio } from "./traxxx.ts";
import { createTraxxxWatchlistStudios } from "./traxxx-watchlist.ts";
import { createBangOriginalsStudio } from "./bang-originals.ts";
import { createFc2CmadbStudio, FC2CMADB_ID } from "./fc2cmadb.ts";
import { createMaximoGarciaStudio } from "./maximo-garcia.ts";
import { createMadouquStudio, MADOUQU_ID } from "./madouqu.ts";
import type { Fc2StudioOptions } from "./fc2cmadb.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
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
  store?: SqliteStore | null;
  /** FC2 pacing and bounds, forwarded from configuration. */
  fc2?: Fc2StudioOptions;
  /** Undefined leaves the Maximo Garcia lane reporting "not configured". */
  maximoListingUrl?: string | undefined;
  /** Hosts the Maximo listing and its video pages may live on. */
  maximoAllowedHosts?: readonly string[];
}

/** The complete set of adapters run by the sync, in a stable order. */
export function createSources({
  madouquApiBase,
  traxxxWatchlist,
  store = null,
  fc2 = {},
  maximoListingUrl,
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
    createBangOriginalsStudio(),
    createFc2CmadbStudio({ ...fc2, store }),
    createMadouquStudio({ apiBase: madouquApiBase }),
  ];
  const watchlist = createTraxxxWatchlistStudios(traxxxWatchlist, [
    ...sources.map((source) => source.id),
    ...RETIRED_SOURCE_IDS,
  ]);
  sources.splice(2, 0, ...watchlist);
  return sources;
}
