/** Bang! Originals unified emission adapter — composite feed from single listing URL. */
import type { SourceAdapter, SourceContext, RawScene } from "./types.js";
export function createBangOriginalsStudio(
  listingUrl?: string,
  _allowedHosts: readonly string[] = [
    "sexlikereal.com",
    "www.sexlikereal.com",
    "analvids.com",
    "www.analvids.com",
  ],
): SourceAdapter {
  return {
    id: "bang-originals",
    name: "Bang Originals",
    authority: {
      name: "Bang! Originals",
      url: "https://bang.com",
      role: "Composite feed from configured listing URL",
    },
    matcher: "sxyprn+eporner",
    async fetch(
      _windowStart: string,
      _ctx: SourceContext,
    ): Promise<{ scenes: RawScene[]; verifiedEmpty: boolean }> {
      if (!listingUrl) throw new Error("Bang Originals listing URL is not configured");
      // Until the listing parser can verify release dates against the requested
      // window, emit nothing and preserve the source's last-good records.
      return { scenes: [], verifiedEmpty: false };
    },
  };
}
