/**
 * The dashboard read model. One function builds everything the UI and the JSON
 * API expose, from the store, so the API and the dashboard can never drift.
 */
import { dateOnly } from "../pipeline/sync.ts";
import type { Config } from "../config.ts";
import type { RunRecord, SqliteStore } from "../core/store/sqlite.ts";
import type { Scene, SourceStatus } from "../core/schema.ts";

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
  scenes: Scene[];
  sources: SourceStatus[];
  latestRun: RunRecord | null;
  refreshing: boolean;
}

export function buildReadModel(
  store: SqliteStore,
  config: Config,
  now: Date,
  { refreshing = false }: { refreshing?: boolean } = {},
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
    scenes,
    sources: store.listSources(),
    latestRun: store.recentRuns(1)[0] ?? null,
    refreshing,
  };
}