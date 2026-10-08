import { createFanslySource } from "./fansly.js";
export function isExcludedMaximoTitle(title) {
  return /(^|[^0-9a-z])trans([^0-9a-z]|$)/i.test(title);
}
export function createMaximoGarciaStudio() {
  return {
    id: "maximo-garcia",
    name: "Maximo Garcia",
    authority: {
      name: "Maximo Garcia",
      url: "https://fansly.com/maximo_garcia",
      role: "Fansly creator posts (public posts only)",
    },
    matcher: "sxyprn+eporner",
    async fetch(windowStart, ctx) {
      const fansly = createFanslySource({ usernames: ["maximo_garcia"] });
      const pulled = await fansly.fetch(windowStart, ctx);
      const excludedSceneIds = [
        ...new Set([
          ...(pulled.excludedSceneIds ?? []),
          ...pulled.scenes
            .filter((scene) => isExcludedMaximoTitle(scene.title))
            .map((scene) => scene.sourceSceneId),
        ]),
      ];
      const scenes = pulled.scenes
        .filter((scene) => !isExcludedMaximoTitle(scene.title))
        .map((scene) => ({ ...scene, studioId: "maximo-garcia", studio: "Maximo Garcia" }));
      return {
        scenes,
        verifiedEmpty:
          scenes.length === 0 ? pulled.verifiedEmpty || excludedSceneIds.length > 0 : false,
        ...(excludedSceneIds.length ? { excludedSceneIds } : {}),
      };
    },
  };
}
