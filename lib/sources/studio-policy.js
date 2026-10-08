export function applyStudioPolicy(source, feed) {
  if (source.id !== feed.adapterId) {
    throw new Error(`Feed ${feed.adapterId} cannot wrap adapter ${source.id}`);
  }
  return {
    ...source,
    authority: { ...source.authority, url: feed.sourceUrl },
    async fetch(windowStart, context) {
      const result = await source.fetch(windowStart, context);
      const policy = feed.studioPolicy;
      if (policy.mode === "split") {
        const scenes = result.scenes.map((scene) => {
          if (scene.studioId?.trim() || scene.studio?.trim()) return scene;
          return { ...scene, metadataPoor: true, studioIdentityMissing: true };
        });
        return { ...result, scenes };
      }
      const scenes = result.scenes.map((scene) => ({
        ...scene,
        providerStudioId: scene.providerStudioId ?? scene.studioId ?? source.id,
        studioId: policy.studioId,
        studio: policy.studio,
      }));
      return { ...result, scenes };
    },
  };
}
