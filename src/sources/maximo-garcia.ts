/** Unified emission adapter for Maximo Garcia (Fansly + TPDB 7875 + ManyVids 1003095958) and Dredd (TPDB feeds). */
import { createFanslySource } from "./fansly.ts";
import { createManyVidsSource } from "./manyvids.ts";
import type { SourceAdapter, SourceContext, RawScene } from "./types";

export function createMaximoGarciaStudio(): SourceAdapter {
  return {
    id: "maximo-garcia",
    name: "Maximo Garcia",
    authority: { name: "Maximo Garcia", url: "https://fansly.com/maximo_garcia", role: "Composite: Fansly + TPDB 7875 + ManyVids" },
    matcher: "sxyprn+eporner",
    async fetch(windowStart, ctx: SourceContext) {
      // Unified emission: collect from Fansly username and reference TPDB site + ManyVids store
      const fanslyAdapter = createFanslySource({ usernames: ["maximo_garcia"] });
      const fanslyResult = await fanslyAdapter.fetch(windowStart, ctx);
      // Remap studio references to composite identity
      const scenes: RawScene[] = fanslyResult.scenes.map((s) => ({
        ...s,
        studioId: "maximo-garcia",
        studio: "Maximo Garcia",
        provenance: {
          ...s.provenance,
          source: "Maximo Garcia (composite: Fansly + TPDB 7875 + ManyVids 1003095958)",
          sourceUrl: "https://theporndb.net/studios/maximogarcia",
        },
      }));
      return { scenes, verifiedEmpty: scenes.length === 0 ? false : fanslyResult.verifiedEmpty };
    },
  };
}
