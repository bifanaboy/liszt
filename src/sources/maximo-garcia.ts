/** Maximo Garcia releases from public Fansly posts. */
import { createFanslySource } from "./fansly.ts";
import type { SourceAdapter, SourceContext, RawScene } from "./types.js";

export function isExcludedMaximoTitle(title: string): boolean {
  return /(^|[^0-9a-z])trans([^0-9a-z]|$)/i.test(title);
}

export function createMaximoGarciaStudio(): SourceAdapter {
  return {
    id: "maximo-garcia",
    name: "Maximo Garcia",
    authority: {
      name: "Maximo Garcia",
      url: "https://fansly.com/maximo_garcia",
      role: "Fansly creator posts (public posts only)",
    },
    matcher: "sxyprn+eporner",
    async fetch(windowStart: string, ctx: SourceContext) {
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
      // Keep the studio label while preserving Fansly provenance.
      const scenes: RawScene[] = pulled.scenes
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
