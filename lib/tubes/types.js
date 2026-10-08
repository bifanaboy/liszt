export function toMatchScene(scene) {
  return {
    id: scene.id,
    title: scene.title,
    source: scene.source,
    sourceId: scene.sourceId,
    label: scene.label,
    performers: scene.performers,
    releaseDate: scene.releaseDate,
    durationSec: scene.durationSec,
    ...(scene.durationRange ? { durationRange: scene.durationRange } : {}),
    durationReview: scene.durationReview,
    ...(scene.studioCode ? { sceneCode: scene.studioCode } : {}),
  };
}
export const RUNGS = ["eporner-pool", "sxyprn"];
