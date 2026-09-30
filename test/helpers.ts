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

/**
 * Fail loudly instead of hanging. A deadlock regression in a concurrency bound
 * is otherwise invisible: the promise never settles, `node --test` waits
 * forever, and the suite is reported as "still running" rather than as broken.
 * `label` is required so the failure says WHICH fan-out wedged.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} (no completion in ${ms}ms)`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
