import { matchTokens } from "../matching.js";
export function performerName(value) {
  const parts = matchTokens(value);
  if (parts.at(-1) === "ls") parts.pop();
  return parts.join(" ");
}
const QUERY_CONFIG = Object.freeze({
  "mambo-perv": Object.freeze({ sceneCodePattern: /\bOB\d{3,}\b/i }),
});
export function configuredSceneCode(scene) {
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
function words(value) {
  return matchTokens(String(value ?? "").replace(/([a-z])([A-Z])/g, "$1 $2"));
}
export function titleQuery(scene) {
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
export function buildQueries(scene) {
  const names = [...new Set(scene.performers.map(performerName).filter(Boolean))].slice(0, 2);
  return [
    ...new Set(
      [
        ...names,
        titleQuery(scene),
        scene.sceneCode ?? configuredSceneCode(scene),
        scene.creatorStudio ? null : scene.label,
      ].filter((value) => Boolean(value)),
    ),
  ];
}
