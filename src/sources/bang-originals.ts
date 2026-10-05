/** Minimal Bang Originals adapter stub. */
import type { SourceAdapter } from "./types";
export function createBangOriginalsStudio(): SourceAdapter {
  return { id: "bang-originals", name: "Bang Originals", authority: { name: "Bang! Originals", url: "https://bang.com", role: "Studio release catalogue" }, matcher: "sxyprn+eporner", async fetch() { return { scenes: [], verifiedEmpty: true }; } };
}
