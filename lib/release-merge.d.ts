import type { ProviderObservation, RawScene, MergePolicy } from "../src/sources/types.ts";
export function mergeRelease(
  observations: readonly ProviderObservation[],
  policy?: MergePolicy,
): RawScene;
