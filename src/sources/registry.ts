/** The source registry. Adding a source is one entry here plus its adapter;
 * everything downstream (sync, matching, serving) reads this list.
 *
 * The source categories, in full:
 *
 *  1. traxxx.me  - Lancelot Styles Evolution, Mambo Perv, Woodman Casting X
 *                  (minus its XXXX scenes), plus the checked watchlist. No
 *                  auth; TPDB adds a separate authenticated watchlist lane.
<<<<<<< HEAD
 *  2. fc2cmadb.com - the FC2 anal-tag lane. Its listing is cursor-paginated
 *                  Inertia HTML, its detail pages are paced at 8-9 seconds, and
 *                  its candidates' decisions live in `fc2_candidates` so a sync
 *                  never repays a detail request it already made.
 *  3. madouqu.com - eleven category ids, Mandarin classifier, metadata only.
 *  4. ManyVids - public creator store listings, incremental plus weekly full pulls.
 *  5. TPDB - one shared token, exact cleaned-name studio matching.
=======
 *  2. Direct URL scrape - Bang! Originals (verified parsers) and Maximo Garcia
 *                  (traxxx measures no scenes for it; listing is configured).
 *  3. fc2cmadb.com - the FC2 anal-tag lane. Its listing is cursor-paginated
 *                  Inertia HTML, its detail pages are paced at 8-9 seconds, and
 *                  its candidates' decisions live in `fc2_candidates` so a sync
 *                  never repays a detail request it already made.
 *  4. madouqu.com - eleven category ids, Mandarin classifier, metadata only.
 *  5. ManyVids - public creator store listings, incremental plus weekly full pulls.
 *  6. TPDB - one shared token, exact cleaned-name studio matching.
>>>>>>> main
 */
import { createManyVidsSource } from "./manyvids.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
import { createTraxxxWatchlistStudios, parseTraxxxListingUrl } from "./traxxx-watchlist.ts";
import { createFc2CmadbStudio, FC2CMADB_ID, type Fc2StudioOptions } from "./fc2cmadb.ts";
import { createMadouquStudio, MADOUQU_ID } from "./madouqu.ts";
import { createTpdbWatchlistSource, type TpdbStudio } from "./tpdb-watchlist.ts";
import { parseTpdbListingUrl, tpdbListingUrlsToStudios } from "./tpdb-listing-url.ts";
import { createFanslySource } from "./fansly.ts";
import { createWoodmanCastingXSource } from "./woodman-casting-x.ts";
import type { SourceAdapter } from "./types.ts";
<<<<<<< HEAD
import type { StudioLink } from "./studio-identity.ts";
=======
import { createTpdbWatchlistSource, type TpdbStudio } from "./tpdb-watchlist.ts";
>>>>>>> main

export const RETIRED_SOURCE_IDS: readonly string[] = Object.freeze([
  "tushy",
  "lancelot-styles-evolution",
  "mambo-perv",
<<<<<<< HEAD
  "bang-originals",
  "maximo-garcia",
=======
>>>>>>> main
]);

/** The Asian-language lanes, listed here because the dashboard splits them onto
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
<<<<<<< HEAD
  /** TPDB API key. When omitted the TPDB watchlist lane is skipped rather than
   * failing every cycle, following the SETUP REQUIRED pattern. */
  tpdbApiKey?: string;
  /** Studios declared by TPDB listing address, parsed into siteId + tags.
   *  Each URL becomes a lane scoped to that site and its tag filter.
   *  The tag filter is applied client-side (TPDB's own tag filter is broken),
   *  and the `site_id` is forwarded to the API. Unknown query parameters are
   *  rejected at boot time rather than silently ignored.
   */
  tpdbListingUrls?: readonly string[];
  /** Studios declared by URL, with their TPDB site ids already resolved.
   *
   *  These take precedence over the name-derived studios below, and any Traxxx
   *  lane they do not mention keeps the old name lookup. That is what makes the
   *  migration incremental: declaring one studio pins it exactly, and everything
   *  else behaves as before.
   */
  studioLinks?: readonly StudioLink[];
  /** Fansly usernames to watch. Each username becomes a lane with studioId
   *  `fansly-<username>`. Public posts only; subscriber-only content requires
   *  a sessionToken which this adapter does not handle. */
  fanslyUsernames?: readonly string[];
  /** Minimum spacing between Fansly API requests (default 2000ms). */
  fanslyMinIntervalMs?: number;
=======
  /** Undefined leaves the Maximo Garcia lane reporting "not configured". */
  maximoListingUrl?: string | undefined;
  /** Hosts the Maximo listing and its video pages may live on. */
  maximoAllowedHosts?: readonly string[];
  /** TPDB API key. When omitted the TPDB watchlist lane is skipped rather than
   * failing every cycle, following the SETUP REQUIRED pattern. */
  tpdbApiKey?: string;
>>>>>>> main
}

/** The complete set of adapters run by the sync, in a stable order. */
export function createSources({
  madouquApiBase,
  traxxxWatchlist,
  store,
  fc2 = {},
  manyvidsStoreIds = ["1003095958"],
  manyvidsMinIntervalMs = 400,
<<<<<<< HEAD
  tpdbApiKey,
  tpdbListingUrls,
  studioLinks,
  fanslyUsernames,
  fanslyMinIntervalMs,
=======
  maximoAllowedHosts = [
    "sexlikereal.com",
    "www.sexlikereal.com",
    "analvids.com",
    "www.analvids.com",
  ],
  tpdbApiKey,
>>>>>>> main
}: RegistryOptions): SourceAdapter[] {
  const sources = [
    ...[...new Set(manyvidsStoreIds)].map((storeId) =>
      createManyVidsSource({ storeId, store, minIntervalMs: manyvidsMinIntervalMs }),
    ),
    createFc2CmadbStudio({ ...fc2, store }),
    createMadouquStudio({ apiBase: madouquApiBase }),
  ];
  if (fanslyUsernames && fanslyUsernames.length > 0) {
    sources.push(
      createFanslySource({ usernames: fanslyUsernames, minIntervalMs: fanslyMinIntervalMs }),
    );
  }
  const watchlist = createTraxxxWatchlistStudios(traxxxWatchlist, [
    ...sources.map((source) => source.id),
    ...RETIRED_SOURCE_IDS,
  ]);
  sources.splice(2, 0, ...watchlist, createWoodmanCastingXSource());
<<<<<<< HEAD
  const declared = studioLinks ?? [];
  // TPDB listing addresses: each becomes a lane scoped to siteId + tag filter.
  // These take precedence over name-derived studios; any Traxxx lane not mentioned
  // keeps the old name lookup, enabling incremental migration.
  const tpdbStudiosFromUrls = (tpdbListingUrls ?? []).flatMap((rawUrl): TpdbStudio[] => {
    const _spec = parseTpdbListingUrl(rawUrl);
    const studios = tpdbListingUrlsToStudios([rawUrl]);
    const studio = studios[0];
    if (!studio) return [];
    return [studio];
  });
  // Convert declared StudioLink[] to TpdbStudio[] for the studios array
  const declaredStudios: TpdbStudio[] = [];
  for (const link of declared) {
    const studio: TpdbStudio = {
      studioId: link.studioId,
      studio: link.studio,
      aliases: [...new Set([link.studio, ...(link.aliases ?? [])])],
      siteIds: link.tpdb?.siteIds ?? [],
    };
    if (link.tags?.length) studio.tags = link.tags;
    declaredStudios.push(studio);
  }
  const studios: TpdbStudio[] = [
    // A declared studio carries its resolved TPDB site id, so both databases file
    // their releases under one key and the TPDB lane needs no name lookup for it.
    ...declaredStudios,
    // Every Traxxx lane not already declared keeps the name-lookup behaviour, so
    // an undeclared lane still works and the migration can be done studio by
    // studio rather than all at once.
    ...watchlist
      .filter((source) => !declared.some((link) => link.studioId === source.id))
      .map((source): TpdbStudio => {
        const lane = traxxxWatchlist
          .map(parseTraxxxListingUrl)
          .find((spec) => spec.id === source.id)!;
        return {
          studioId: source.id,
          studio: source.name,
          aliases: [
            source.name,
            source.id,
            ...(TPDB_STUDIO_ALIASES[lane.slug] ?? []),
          ] as readonly string[],
          tags: lane.tags as readonly string[] | undefined,
          siteIds: [],
        };
      })
      .filter((s): s is TpdbStudio => s !== undefined),
    // ManyVids stores only contribute an alias when the store has a real display
    // name. A synthetic `ManyVids store <id>` label can never match a TPDB site
    // name, and registering it would let two unrelated stores collide on the same
    // cleaned alias and silently exclude a real studio (issue: synthetic aliases
    // create false collision opportunities).
    ...[...new Set(manyvidsStoreIds)].flatMap((storeId): TpdbStudio[] => {
      const name = MANYVIDS_STUDIO_NAMES[storeId];
      return [
        {
          studioId: `manyvids-${storeId}`,
          studio: name ?? `ManyVids store ${storeId}`,
          aliases: name ? [name] : ([] as readonly string[]),
          siteIds: [],
        },
      ];
    }),
    // TPDB listing address studios, declared by URL rather than by name.
    ...tpdbStudiosFromUrls,
  ];
  sources.push(createTpdbWatchlistSource({ token: tpdbApiKey, studios }));
=======

  // Build the TPDB studio alias map from watchlist and ManyVids sources.
  // ManyVids synthetic aliases (manyvids-<id>) are excluded from TPDB matching
  // because they can never match a TPDB site name — they are silently inert
  // (issue: synthetic aliases create false collision opportunities). Only
  // unambiguous TPDB-derived aliases and the watchlist sources themselves
  // participate in studio matching.
  const tpdbStudios: TpdbStudio[] = [
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
    tpdbStudios.push(
      ...[...new Set(manyvidsStoreIds)].map((storeId) => ({
        studioId: `manyvids-${storeId}`,
        studio: storeId === "1003095958" ? "Maximo Garcia" : `ManyVids store ${storeId}`,
        aliases: [storeId === "1003095958" ? "Maximo Garcia" : `ManyVids store ${storeId}`],
      })),
    );
  }

  sources.push(createTpdbWatchlistSource({ token: tpdbApiKey, studios: tpdbStudios }));
>>>>>>> main
  return sources;
}
