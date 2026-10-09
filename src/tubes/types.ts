/**
 * The playback-link types, and the shape the ladder resolves into.
 *
 * The safety rule: **a missing high-confidence link is preferable to a wrong
 * high-confidence link.** Each tube returns candidates that cleared duration
 * and date; a title that identifies the scene makes a high-confidence match,
 * while an unnamed candidate can only be linked by the terminal fallback.
 *
 * The terminal fallback runs only after every tube has declined to produce a
 * named match. It selects the highest-view date-and-duration survivor across
 * all tubes and flags the link `low`, so popularity is never mistaken for
 * identity.
 *
 * This replaced the older wording here, which said there was no
 * partial-confidence path at all. `RungOutcome`'s confidence field is how a
 * reader distinguishes named matches from the explicit fallback.
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
  durationRange?: { minSec: number; maxSec: number };
  durationReview?: boolean;
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
    ...(scene.durationRange ? { durationRange: scene.durationRange } : {}),
    durationReview: scene.durationReview,
    ...(scene.studioCode ? { sceneCode: scene.studioCode } : {}),
  };
}

/**
 * Why a source did not produce a link. The distinction is recorded, not
 * swallowed:
 *
 *  - `no-match` is a clean negative. The scene is recorded as checked and
 *    retried on a later cycle.
 *  - `error` means the source was UNABLE to answer. The other source still
 *    contributes candidates. An error is not a clean no-match.
 */
export type RungOutcome =
  | { status: "matched"; url: string; source: string; confidence: "high" | "low" }
  | { status: "no-match" }
  | { status: "error"; error: string };

/** The equal-ranked playback sources used by the resolver. */
export const RUNGS = ["eporner", "sxyprn"] as const;
export type Rung = (typeof RUNGS)[number];
