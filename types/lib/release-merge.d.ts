declare module "*lib/release-merge.js" {
  type ProviderObservation = import("../../src/sources/types.ts").ProviderObservation;
  type RawScene = import("../../src/sources/types.ts").RawScene;
  type MergePolicy = import("../../src/sources/types.ts").MergePolicy;
  export function mergeRelease(
    observations: readonly ProviderObservation[],
    policy?: MergePolicy,
  ): RawScene;
}
