/**
 * Woodman Casting X, minus the studio's own XXXX scenes (#82).
 *
 * The studio writes `XXXX` as a standalone token in the scene title and nowhere
 * else usable. Verified against the traxxx channel record and the studio's own
 * pages on 2026-10-03:
 *
 *   725814  "Mery Colt - XXXX - A DP was not enough, I tried DVP too"
 *           woodmancastingx.com/casting-x/mery-colt-xxxx-a-dp-..._42074.html
 *           page title: "Mery Colt - XXXX - A DP was not enough, I tried DVP too"
 *   725778  "Mery Colt casting"
 *           woodmancastingx.com/casting-x/mery-colt_42062.html
 *           page title: "Mery Colt on Woodman casting X" - no marker
 *
 * The marker is read from traxxx's title, which is the studio's own title, and
 * NOT from the studio page's HTML: that page carries "Woodman casting X" in its
 * chrome, so every scene there looks marked. The token is delimited, because the
 * channel's real titles include "Shania VegaX casting", "Lexxxus Adams
 * casting", "Area X69" and "- BTS -" scenes that must all stay eligible.
 *
 * This lane is a plain traxxx channel with one exclusion, so it keeps the shared
 * filter guard, the window filter, the rolling-window stop, and the last-good
 * behaviour every other source has. No matching rule is touched.
 */
import { createTraxxxStudio } from "./traxxx.ts";
import type { SourceAdapter } from "./types.ts";

export const WOODMAN_CASTING_X_ID = "woodman-casting-x";
export const WOODMAN_CASTING_X_SLUG = "woodmancastingx";

/** The studio's rating marker as a whole token, not a run of x's anywhere. */
export const XXXX_TITLE_MARKER = /\bXXXX\b/;

export function isXxxxMarkedTitle(title: unknown): boolean {
  return XXXX_TITLE_MARKER.test(String(title ?? ""));
}

export function createWoodmanCastingXSource(): SourceAdapter {
  return createTraxxxStudio({
    id: WOODMAN_CASTING_X_ID,
    name: "Woodman Casting X",
    kind: "channel",
    slug: WOODMAN_CASTING_X_SLUG,
    exclude: (record) => isXxxxMarkedTitle(record?.title),
  });
}
