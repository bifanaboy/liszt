/**
 * The playback-link types, and the shape the ladder resolves into.
 *
 * The safety rule, in its current form: **a missing link is preferable to a
 * wrong link.** Every rung returns either a link that cleared the shared gate -
 * duration band, upload window, and a title that identifies the scene - or
 * nothing at all, and a rung with nothing hands the scene to the next tube.
 *
 * The plan proposes one exception: after every tube declines, link the
 * most-watched near-miss, flagged `low`. That decision remains unconfirmed, so
 * this exception is NOT implemented; until it is, a scene no tube can name
 * stays unlinked.
 *
 * This replaced the older wording here, which said there was no
 * partial-confidence path at all. That statement is still true of the current
 * implementation. `RungOutcome` keeps the confidence field for the pending
 * decision, but no current rung writes a link without identity evidence.
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

/**
 * The ordered rungs. Nominal order.
 *
 * `eporner-open` is gone, and the list is the record of that. The eporner v2
 * search API takes no upload date, so a 90-day-old release could only be
 * reached by paginating backwards from `order=latest` with no reliable stop;
 * and the uploader appears in no API response, only in video page markup, so
 * the rung could never tell a trusted repost from an untrusted account's
 * upload. It contributed one link out of 46, and that link belonged to an
 * account outside the trusted pool - so removing it cost that uploader's whole
 * catalogue, not one link. That is the reason the hierarchy exists instead.
 */
export const RUNGS = ["eporner-pool", "sxyprn"] as const;
export type Rung = (typeof RUNGS)[number];
