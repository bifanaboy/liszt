/** Minimal Maximo Garcia composite adapter. Combines Fansly, ManyVids, and TPDB feeds (siteIds [7875]). */
import type { SourceAdapter } from "./types";
export function createMaximoGarciaStudio(): SourceAdapter {
  return { id: "maximo-garcia", name: "Maximo Garcia (composite)", authority: { name: "Maximo Garcia", url: "https://fansly.com/maximo_garcia", role: "Composite: Fansly + TPDB 7875 + ManyVids" }, matcher: "sxyprn+eporner", async fetch() { return { scenes: [], verifiedEmpty: false }; } };
}
