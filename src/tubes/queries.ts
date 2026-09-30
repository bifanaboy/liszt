/**
 * Query construction, shared by the sxyprn and eporner-open rungs.
 *
 * Queries are CHEAP RECALL only. The measured gate in `core/matching.ts` is the
 * single admission mechanism, so a query that returns noise costs a rejection
 * and nothing else. Explicit non-rules, which must not be re-added: no
 * upload-date window, no studio-in-title filter, no tag search, no fuzzy
 * similarity.
 */
import { matchTokens } from "../core/matching.ts";
import type { MatchScene } from "./types.ts";

/** A performer name reduced to its searchable form (a trailing `LS` dropped). */
export function performerName(value: string): string {
  const parts = matchTokens(value);
  if (parts.at(-1) === "ls") parts.pop();
  return parts.join(" ");
}

/** A per-source scene-code pattern (Mambo Perv's OB codes). */
const QUERY_CONFIG: Readonly<Record<string, { sceneCodePattern?: RegExp }>> = Object.freeze({
  "mambo-perv": Object.freeze({ sceneCodePattern: /\bOB\d{3,}\b/i }),
});

/** The scene's configured code, or null. */
export function configuredSceneCode(scene: { sourceId: string; title: string }): string | null {
  const pattern = QUERY_CONFIG[scene.sourceId]?.sceneCodePattern;
  if (!pattern) return null;
  return scene.title.match(pattern)?.[0]?.toLowerCase() ?? null;
}

const COMMON = new Set([
  "a",
  "an",
  "and",
  "at",
  "by",
  "for",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
]);

function words(value: string): string[] {
  return matchTokens(String(value ?? "").replace(/([a-z])([A-Z])/g, "$1 $2"));
}

/** The distinctive title tokens, minus the performer names and common words. */
export function titleQuery(scene: MatchScene): string {
  const names = [...new Set(scene.performers.map(performerName).filter(Boolean))].slice(0, 2);
  const performerTokens = new Set(names.flatMap(words));
  const beforeFeaturing = scene.title.split(/\bfeaturing\b/i)[0] ?? "";
  const core = words(beforeFeaturing).filter(
    (word) => !COMMON.has(word) && !performerTokens.has(word),
  );
  const tokens =
    core.length >= 3
      ? core
      : words(scene.title).filter((word) => !COMMON.has(word) && !performerTokens.has(word));
  return tokens.slice(0, 5).join(" ");
}

/**
 * The candidate-pool queries for a scene: performer names, the title keywords,
 * the scene code, then the label - which is skipped for creator studios, whose
 * label queries return an unhelpful amount of noise.
 */
export function buildQueries(scene: MatchScene): string[] {
  const names = [...new Set(scene.performers.map(performerName).filter(Boolean))].slice(0, 2);
  return [
    ...new Set(
      [
        ...names,
        titleQuery(scene),
        scene.sceneCode ?? configuredSceneCode(scene),
        scene.creatorStudio ? null : scene.label,
      ].filter((value): value is string => Boolean(value)),
    ),
  ];
}
