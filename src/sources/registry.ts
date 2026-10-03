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
 *  3. fc2cmadb.com - a named stub. Its interface is unconfirmed.
 *  4. madouqu.com - eleven category ids, Mandarin classifier, metadata only.
 */
import { createTraxxxStudio } from "./traxxx.ts";
import { createTraxxxWatchlistStudios } from "./traxxx-watchlist.ts";
import { createBangOriginalsStudio } from "./bang-originals.ts";
import { createFc2CmadbStudio } from "./fc2cmadb.ts";
import { createMaximoGarciaStudio } from "./maximo-garcia.ts";
import { createMadouquStudio } from "./madouqu.ts";
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

export interface RegistryOptions {
  madouquApiBase: string;
  traxxxWatchlist: readonly string[];
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
  maximoAllowedHosts = [
    "sexlikereal.com",
    "www.sexlikereal.com",
    "analvids.com",
    "www.analvids.com",
  ],
}: RegistryOptions): SourceAdapter[] {
  return [
    lancelotStylesEvolution,
    mamboPerv,
    ...createTraxxxWatchlistStudios(traxxxWatchlist),
    createMaximoGarciaStudio(maximoListingUrl, maximoAllowedHosts),
    createBangOriginalsStudio(),
    createFc2CmadbStudio(),
    createMadouquStudio({ apiBase: madouquApiBase }),
  ];
}
