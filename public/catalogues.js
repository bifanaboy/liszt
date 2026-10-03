import { isLiveLink } from "./source-health.js";

/**
 * The two catalogue pages. The main one holds every lane except the
 * Asian-language ones (FC2 and Madouqu), which have their own page so the main
 * list is not mostly Japanese-language titles (#65).
 *
 * Which sources those are is NOT decided here: `asianSourceIds` arrives with the
 * catalogue response from the source registry, so this module cannot fall out of
 * step with a renamed lane id.
 */
export const MAIN_CATALOGUE = "catalogue";
export const ASIAN_CATALOGUE = "asian";

/** Resolve a nav id or hash fragment to a catalogue, or null when it names neither. */
export function catalogueId(value) {
  const id = String(value ?? "").replace(/^#/, "").toLowerCase();
  if (id === ASIAN_CATALOGUE) return ASIAN_CATALOGUE;
  return id === MAIN_CATALOGUE ? MAIN_CATALOGUE : null;
}

/**
 * Whether a scene or source status belongs to the Asian page.
 *
 * `sourceId`, not `labelId`: a lane may emit several sub-labels, and they belong
 * to whichever page their source does.
 */
export function isAsian(row, asianSourceIds) {
  const sourceId = String(row?.sourceId ?? "");
  return Boolean(sourceId) && (asianSourceIds || []).includes(sourceId);
}

/** Membership of one page, for a scene or a source status. */
export function inCatalogue(row, catalogue, asianSourceIds) {
  return catalogue === ASIAN_CATALOGUE
    ? isAsian(row, asianSourceIds)
    : !isAsian(row, asianSourceIds);
}

/** The rows of the window one catalogue page shows. */
export function catalogueScenes(scenes, catalogue, asianSourceIds) {
  return (Array.isArray(scenes) ? scenes : []).filter((scene) =>
    inCatalogue(scene, catalogue, asianSourceIds),
  );
}

/**
 * A page's own figures, counted from the rows it shows.
 *
 * The linking percentage is deliberately per page: a single percentage over the
 * whole window would describe a catalogue the reader is not looking at.
 */
export function catalogueStats(scenes, catalogue, asianSourceIds) {
  const owned = catalogueScenes(scenes, catalogue, asianSourceIds);
  const live = owned.filter((scene) => (scene.videoUrls || []).some(isLiveLink)).length;
  return {
    total: owned.length,
    live,
    matchPercent: owned.length ? Math.round((live / owned.length) * 100) : null,
  };
}
