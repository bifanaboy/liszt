/**
 * The dashboard read model. One function builds everything the UI and the JSON
 * API expose, from the store, so the API and the dashboard can never drift.
 */
import { dateOnly } from "../pipeline/sync.ts";
import { idleProgress, type SyncProgress } from "../pipeline/progress.ts";
import type { Config } from "../config.ts";
import type { RunRecord, SqliteStore } from "../core/store/sqlite.ts";
import type { Scene, SourceStatus } from "../core/schema.ts";
import { ASIAN_SOURCE_IDS } from "../sources/registry.ts";

export interface WindowStats {
  total: number;
  /** Scenes with at least one live playback link. */
  live: number;
  /** Scenes with no live link (a valid, expected result). */
  unmatched: number;
  /** Total dead-link history entries across the window. */
  deadLinks: number;
  metadataPoor: number;
}

export interface ReadModel {
  generatedAt: string;
  window: { days: number; from: string; to: string };
  stats: WindowStats;
  /**
   * The sources whose releases belong to the Asian catalogue page, so the
   * dashboard splits the window without hard-coding a lane id of its own.
   *
   * Ids, not scene copies: the page is a filter over the scenes already in this
   * response, which keeps "in the window" and "on this page" the same set.
   */
  asianSourceIds: readonly string[];
  scenes: Scene[];
  sources: SourceStatus[];
  latestRun: RunRecord | null;
  refreshing: boolean;
  /**
   * The live cycle's progress, for the dashboard's meters.
   *
   * Optional, and defaulted to an inactive snapshot, so every existing caller -
   * including the inline fixture in the HTTP tests - keeps working unchanged.
   * It rides along on this response so a first paint that already knows a run
   * is in flight can draw its bar; the meters themselves are driven by the
   * much smaller `/api/progress`, which is polled on its own cadence.
   */
  progress: SyncProgress;
}

export function buildReadModel(
  store: SqliteStore,
  config: Config,
  now: Date,
  { refreshing = false, progress }: { refreshing?: boolean; progress?: SyncProgress } = {},
): ReadModel {
  const to = dateOnly(now);
  const from = dateOnly(new Date(now.getTime() - config.windowDays * 86_400_000));
  const scenes = store.listWindow(from, to);
  const live = scenes.filter((scene) => scene.videoUrls.length > 0).length;
  return {
    generatedAt: now.toISOString(),
    window: { days: config.windowDays, from, to },
    stats: {
      total: scenes.length,
      live,
      unmatched: scenes.length - live,
      deadLinks: scenes.reduce((total, scene) => total + scene.deadVideoUrls.length, 0),
      metadataPoor: scenes.filter((scene) => scene.metadataPoor).length,
    },
    asianSourceIds: ASIAN_SOURCE_IDS,
    scenes,
    sources: store.listSources(),
    latestRun: store.recentRuns(1)[0] ?? null,
    refreshing,
    progress: progress ?? idleProgress(),
  };
}
