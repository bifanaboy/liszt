/** The dashboard read model. One function builds everything the UI and the JSON API expose, from the store, so the API and the dashboard can never drift. */
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
  /** The sources whose releases belong to the Asian catalogue page, so the dashboard splits the window without hard-coding a lane id of its own.
   * Ids, not scene copies: the page is a filter over the scenes already in this response, which keeps "in the window" and "on this page" the same set.
   */
  asianSourceIds: readonly string[];
  scenes: Scene[];
  sources: SourceStatus[];
  latestRun: RunRecord | null;
  refreshing: boolean;
  /** The live cycle's progress, for the dashboard's meters.
   * Optional, and defaulted to an inactive snapshot, so every existing caller -
   * including the inline fixture in the HTTP tests - keeps working unchanged.
   * It rides along on this response so a first paint that already knows a run is in flight can draw its bar; the meters themselves are driven by the much smaller /api/progress, which is polled on its own cadence.
   */
  progress: SyncProgress;
}

function releaseUrlKey(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.href;
  } catch {
    return value;
  }
}

function titleKey(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Merge duplicate TPDB/storefront/watchlist records for display, filling only absent metadata. */
export function mergeWatchlistDuplicates(scenes: Scene[]): Scene[] {
  const output: Scene[] = [];
  for (const scene of scenes) {
    const isProvider =
      scene.sourceId === "tpdb-watchlist" ||
      scene.source.toLowerCase().includes("manyvids") ||
      scene.source.toLowerCase().includes("traxxx");
    const match = isProvider
      ? output.find((prior) => {
          if (prior.labelId !== scene.labelId || prior.sourceId === scene.sourceId) return false;
          const firstUrl = releaseUrlKey(prior.releaseUrl);
          const secondUrl = releaseUrlKey(scene.releaseUrl);
          if (firstUrl && secondUrl) return firstUrl === secondUrl;
          return Boolean(
            prior.durationSec &&
            scene.durationSec &&
            prior.releaseDate === scene.releaseDate &&
            prior.durationSec === scene.durationSec &&
            titleKey(prior.title) === titleKey(scene.title),
          );
        })
      : undefined;
    if (!match) {
      output.push(scene);
      continue;
    }
    const fill = <
      K extends
        | "title"
        | "performers"
        | "durationSec"
        | "thumbnailUrl"
        | "tags"
        | "releaseUrl"
        | "storeId"
        | "launchDate"
        | "previewUrl"
        | "price"
        | "studioCode",
    >(
      field: K,
    ): void => {
      const current = match[field];
      const incoming = scene[field];
      const empty =
        current === undefined ||
        current === null ||
        current === "" ||
        (Array.isArray(current) && current.length === 0);
      const present =
        incoming !== undefined &&
        incoming !== null &&
        incoming !== "" &&
        (!Array.isArray(incoming) || incoming.length > 0);
      if (empty && present) Object.assign(match, { [field]: incoming });
    };
    for (const field of [
      "title",
      "performers",
      "durationSec",
      "thumbnailUrl",
      "tags",
      "releaseUrl",
      "storeId",
      "launchDate",
      "previewUrl",
      "price",
      "studioCode",
    ] as const)
      fill(field);
    match.metadataPoor = match.metadataPoor && scene.metadataPoor;
    // Preserve videoMatching from the prior match so the LOW CONFIDENCE
    // tag is retained when a TPDB fallback is merged (issue #114 / CRITICAL).
    if (match.videoMatching === undefined && scene.videoMatching !== undefined) {
      match.videoMatching = scene.videoMatching;
    }
    Object.assign(match, {
      provenance: [
        ...match.provenance,
        ...scene.provenance.filter(
          (item) =>
            !match.provenance.some(
              (prior) => prior.source === item.source && prior.recordUrl === item.recordUrl,
            ),
        ),
      ],
      fieldProvenance: { ...scene.fieldProvenance, ...match.fieldProvenance },
      videoMatching: match.videoMatching,
      videoUrls: [
        ...match.videoUrls,
        ...scene.videoUrls.filter(
          (link) => !match.videoUrls.some((prior) => prior.url === link.url),
        ),
      ],
      deadVideoUrls: [
        ...match.deadVideoUrls,
        ...scene.deadVideoUrls.filter(
          (link) => !match.deadVideoUrls.some((prior) => prior.url === link.url),
        ),
      ],
    });
  }
  return output;
}

export function buildReadModel(
  store: SqliteStore,
  config: Config,
  now: Date,
  { refreshing = false, progress }: { refreshing?: boolean; progress?: SyncProgress } = {},
): ReadModel {
  const to = dateOnly(now);
  const from = dateOnly(new Date(now.getTime() - config.windowDays * 86_400_000));
  const scenes = mergeWatchlistDuplicates(store.listWindow(from, to));
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
