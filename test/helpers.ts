/** Shared test fixtures. Not a `*.test.ts`, so the runner ignores it. */
import { parseAtBoundary, Scene } from "../src/core/schema.ts";
import type { MatchScene } from "../src/tubes/types.ts";
import type { EpornerOpenMatch } from "../src/tubes/eporner.ts";
import type { IdentityTier } from "../src/core/matching.ts";

export interface LegacyPoolMatch {
  url: string;
  embedUrl: string;
  videoId: string;
  uploader: string;
  title: string;
  identityTier: IdentityTier;
  lagDays: number | null;
  candidatesConsidered: number;
  durationPassed: number;
  hydrated: number;
  rejectedByDate: number;
  unknownDate: number;
  hydrationCapped: boolean;
  omittedCandidates: number;
  fallbackCandidates: Array<{
    url: string;
    title: string;
    duration: number;
    added: string | null;
    views: number | string | null;
  }>;
  rejected: "duration" | "date" | "none" | "incomplete" | null;
}

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

export function poolResultAsEpornerMatches(
  result: LegacyPoolMatch | null,
  scene: MatchScene,
): EpornerOpenMatch[] {
  if (!result) return [];
  const items = [
    ...(result.url
      ? [
          {
            url: result.url,
            title: result.title,
            duration: scene.durationSec ?? 600,
            added: scene.releaseDate,
            views: 1_000,
            tier: result.identityTier,
          },
        ]
      : []),
    ...result.fallbackCandidates.map((candidate) => ({ ...candidate, tier: 0 as const })),
  ];
  return items.map((item) => {
    const url = String(item.url ?? "");
    const id = url.match(/video-([^/]+)/)?.[1] ?? "test";
    const candidate = {
      url,
      title: item.title,
      duration: item.duration,
      added: item.added,
      views: item.views,
    };
    return {
      video: {
        id,
        url: candidate.url,
        title: candidate.title,
        embed: `https://www.eporner.com/embed/${id}/`,
        length_sec: candidate.duration == null ? undefined : candidate.duration,
        added: candidate.added ?? undefined,
        views: candidate.views,
      },
      candidate,
      identityTier: item.tier,
    };
  });
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
