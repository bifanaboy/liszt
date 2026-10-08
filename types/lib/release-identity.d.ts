declare module "*lib/release-identity.js" {
  type RawScene = import("../../src/sources/types.ts").RawScene;
  export function releaseIdentity(raw: Pick<RawScene, "releaseUrl">): string | undefined;
}
