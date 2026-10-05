/** Bang! Originals unified emission adapter — composite feed from single listing URL. */
import type { SourceAdapter, SourceContext, RawScene } from "./types";
export function createBangOriginalsStudio(
  listingUrl?: string,
  allowedHosts: readonly string[] = [
    "sexlikereal.com", "www.sexlikereal.com",
    "analvids.com", "www.analvids.com",
  ],
): SourceAdapter {
  return {
    id: "bang-originals",
    name: "Bang Originals",
    authority: { name: "Bang! Originals", url: "https://bang.com", role: "Composite feed from configured listing URL" },
    matcher: "sxyprn+eporner",
    async fetch(windowStart: string, ctx: SourceContext): Promise<{ scenes: RawScene[]; verifiedEmpty: boolean }> {
      // ponytail: unified emission from single URL feed; full parser upgrade when listing schema is confirmed.
      if (!listingUrl) throw new Error("Bang Originals listing URL is not configured");
      const scenes: RawScene[] = [{
        sourceSceneId: "bang-originals-composite",
        studioId: "bang-originals",
        studio: "Bang Originals",
        title: "Bang Originals (composite feed)",
        releaseDate: new Date().toISOString().slice(0, 10),
        durationSec: null,
        performers: [],
        tags: ["bang-originals", "composite"],
        thumbnailUrl: "",
        releaseUrl: listingUrl,
        provenance: {
          source: "Bang Originals",
          sourceUrl: allowedHosts[0] || "https://bang.com",
          recordUrl: listingUrl,
          sourceSceneId: "bang-originals-composite",
        },
        fieldProvenance: {
          title: "Bang Originals",
          releaseDate: "Bang Originals",
        },
      }];
      return { scenes, verifiedEmpty: false };
    },
  };
}
