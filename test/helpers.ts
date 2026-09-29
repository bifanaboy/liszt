/** Shared test fixtures. Not a `*.test.ts`, so the runner ignores it. */
import { parseAtBoundary, Scene } from "../src/core/schema.ts";
import type { MatchScene } from "../src/tubes/types.ts";

export function makeScene(over: Partial<Scene> & { id: string }): Scene {
  const candidate: Record<string, unknown> = {
    sourceId: "test",
    source: "test",
    labelId: "test",
    label: "Test",
    title: "Scene",
    performers: [],
    releaseDate: "2026-03-04",
    durationSec: 600,
    provenance: [{ source: "test", fetchedAt: "2026-03-04T00:00:00Z" }],
    ...over,
  };
  return parseAtBoundary(Scene, candidate, `test.scene(${over.id})`);
}

export function makeMatchScene(over: Partial<MatchScene> & { id: string }): MatchScene {
  return {
    title: "Scene",
    source: "test",
    sourceId: "test",
    label: "Test",
    performers: [],
    releaseDate: "2026-03-04",
    durationSec: 600,
    ...over,
  };
}