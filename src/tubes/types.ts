/**
 * The playback-link types, and the shape the ladder resolves into.
 *
 * The safety rule, inherited unchanged: **a missing link is preferable to a
 * wrong link.** Every rung returns either a link that cleared the shared gate
 * or nothing at all. There is no partial-confidence path that writes a URL.
 */
import type { Scene } from "../core/schema.ts";

/** The scene fields the tube matchers read. */
export interface MatchScene {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  label: string;
  creatorStudio?: boolean;
  performers: string[];
  releaseDate: string;
  durationSec: number | null;
  /** Scene-code retrieval hint, e.g. Mambo Perv's OB codes. */
  sceneCode?: string;
}

export function toMatchScene(scene: Scene): MatchScene {
  return {
    id: scene.id,
    title: scene.title,
    source: scene.source,
    sourceId: scene.sourceId,
    label: scene.label,
    performers: scene.performers,
    releaseDate: scene.releaseDate,
    durationSec: scene.durationSec,
    ...(scene.studioCode ? { sceneCode: scene.studioCode } : {}),
  };
}

/**
 * Why a rung did not produce a link. The distinction the plan draws is
 * load-bearing and is recorded, not swallowed:
 *
 *  - `no-match` is a clean negative. The scene is recorded as checked and
 *    retried on a later cycle.
 *  - `error` means the rung was UNABLE to answer. An error lets the next rung
 *    run and leaves the scene unlinked. A source that errors is not a source
 *    that found nothing.
 */
export type RungOutcome =
  | { status: "matched"; url: string; source: string; confidence: "high" | "low" }
  | { status: "no-match" }
  | { status: "error"; error: string };

/** The ordered rungs. Nominal order; see the plan's "effective ladder" note. */
export const RUNGS = ["eporner-pool", "sxyprn", "eporner-open"] as const;
export type Rung = (typeof RUNGS)[number];
