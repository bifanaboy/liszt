/** Maximo Garcia releases from public Fansly posts. */
import { createFanslySource } from "./fansly.ts";
import type { SourceAdapter, SourceContext, RawScene } from "./types.js";

export function createMaximoGarciaStudio(
  _listingUrl?: string,
  _allowedHosts: readonly string[] = [
    "sexlikereal.com",
    "www.sexlikereal.com",
    "analvids.com",
    "www.analvids.com",
  ],
): SourceAdapter {
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
      const fanslyAdapter = createFanslySource({ usernames: ["maximo_garcia"] });
      const fanslyResult = await fanslyAdapter.fetch(windowStart, ctx);
      // Keep the studio label while preserving Fansly provenance.
      const scenes: RawScene[] = fanslyResult.scenes.map((s) => ({
        ...s,
        studioId: "maximo-garcia",
        studio: "Maximo Garcia",
      }));
      return { scenes, verifiedEmpty: scenes.length === 0 ? true : fanslyResult.verifiedEmpty };
    },
  };
}
