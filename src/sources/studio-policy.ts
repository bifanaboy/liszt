import type { FeedDefinition, RawScene, SourceAdapter, SourceResult } from "./types.ts";

/** Apply the feed's studio assignment while leaving its provider evidence intact. */
export function applyStudioPolicy(source: SourceAdapter, feed: FeedDefinition): SourceAdapter {
  if (source.id !== feed.adapterId) {
    throw new Error(`Feed ${feed.adapterId} cannot wrap adapter ${source.id}`);
  }
  return {
    ...source,
    authority: { ...source.authority, url: feed.sourceUrl },
    async fetch(windowStart, context): Promise<SourceResult> {
      const result = await source.fetch(windowStart, context);
      const policy = feed.studioPolicy;
      if (policy.mode === "split") return result;
      const scenes: RawScene[] = result.scenes.map((scene) => ({
        ...scene,
        providerStudioId: scene.providerStudioId ?? scene.studioId ?? source.id,
        studioId: policy.studioId,
        studio: policy.studio,
      }));
      return { ...result, scenes };
    },
  };
}
