import { createTraxxxStudio } from "./traxxx.js";
export const WOODMAN_CASTING_X_ID = "woodman-casting-x";
export const WOODMAN_CASTING_X_SLUG = "woodmancastingx";
export const XXXX_TITLE_MARKER = /\bXXXX\b/;
export function isXxxxMarkedTitle(title) {
  return XXXX_TITLE_MARKER.test(String(title ?? ""));
}
export function createWoodmanCastingXSource() {
  return createTraxxxStudio({
    id: WOODMAN_CASTING_X_ID,
    name: "Woodman Casting X",
    kind: "channel",
    slug: WOODMAN_CASTING_X_SLUG,
    exclude: (record) => isXxxxMarkedTitle(record?.title),
  });
}
