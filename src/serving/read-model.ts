/** The dashboard read model. One function builds everything the UI and the JSON API expose, from the store, so the API and the dashboard can never drift. */
import { dateOnly } from "../pipeline/sync.ts";
import { idleProgress, type SyncProgress } from "../pipeline/progress.ts";
import type { Config } from "../config.ts";
import type { RunRecord, SqliteStore } from "../core/store/sqlite.ts";
import type { Scene, SourceStatus } from "../core/schema.ts";
import { ASIAN_SOURCE_IDS } from "../sources/registry.ts";
import { cleanStudioName } from "../sources/tpdb-watchlist.ts";

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
  return cleanStudioName(value);
}

/** Merge duplicate TPDB/storefront/watchlist records for display, filling only absent metadata. */
export function mergeWatchlistDuplicates(scenes: Scene[]): Scene[] {
  const output: Scene[] = [];
  const contributors = new Map<Scene, Set<string>>();
  const candidates = new Map<string, Set<Scene>>();
  const keysFor = (scene: Scene): string[] => {
    const label = scene.labelId;
    const url = releaseUrlKey(scene.releaseUrl);
    const keys = url ? [`url:${label}\0${url}`] : [];
    if (scene.durationSec)
      keys.push(
        `fallback:${label}\0${titleKey(scene.title)}\0${scene.releaseDate}\0${scene.durationSec}`,
      );
    return keys;
  };
  const index = (scene: Scene) => {
    for (const key of keysFor(scene)) {
      const group = candidates.get(key) ?? new Set<Scene>();
      group.add(scene);
      candidates.set(key, group);
    }
  };
  for (const scene of scenes) {
    const isProvider =
      scene.sourceId === "tpdb-watchlist" ||
      scene.source.toLowerCase().includes("manyvids") ||
      scene.source.toLowerCase().includes("traxxx");
    const url = releaseUrlKey(scene.releaseUrl);
    const fallbackKey = scene.durationSec
      ? `fallback:${scene.labelId}\0${titleKey(scene.title)}\0${scene.releaseDate}\0${scene.durationSec}`
      : "";
    const match = isProvider
      ? (() => {
          const eligible = (prior: Scene) => {
            const sources = contributors.get(prior) ?? new Set([prior.sourceId]);
            return (
              !sources.has(scene.sourceId) &&
              prior.labelId === scene.labelId &&
              prior.sourceId !== scene.sourceId
            );
          };
          if (url) {
            const exact = [...(candidates.get(`url:${scene.labelId}\0${url}`) ?? [])].filter(
              eligible,
            );
            if (exact.length) return exact.length === 1 ? exact[0] : undefined;
          }
          const fallback = [...(candidates.get(fallbackKey) ?? [])].filter(
            (prior) => eligible(prior) && (!url || !releaseUrlKey(prior.releaseUrl)),
          );
          return fallback.length === 1 ? fallback[0] : undefined;
        })()
      : undefined;
    if (!match) {
      output.push(scene);
      contributors.set(scene, new Set([scene.sourceId]));
      index(scene);
      continue;
    }
    contributors.get(match)!.add(scene.sourceId);
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
    match.metadataPoor = match.metadataPoor && scene.metadataPoor;
    const filledProvenance = { ...match.fieldProvenance };
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
    ] as const) {
      const before = match[field];
      fill(field);
      if (before !== match[field] && scene.fieldProvenance[field])
        filledProvenance[field] = scene.fieldProvenance[field]!;
    }
    const samePlaybackWinner = match.videoUrls[0]?.url === scene.videoUrls[0]?.url;
    const useIncomingVerdict =
      !match.videoUrls.length ||
      (samePlaybackWinner &&
        match.videoMatching?.confidence === "low" &&
        scene.videoMatching?.confidence === "high");
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
      fieldProvenance: filledProvenance,
      videoUrls: match.videoUrls.length
        ? match.videoUrls
        : scene.videoUrls.filter(
            (link) => !match.deadVideoUrls.some((dead) => dead.url === link.url),
          ),
      deadVideoUrls: [
        ...match.deadVideoUrls,
        ...scene.deadVideoUrls.filter(
          (dead) => !match.deadVideoUrls.some((prior) => prior.url === dead.url),
        ),
      ],
      videoMatching: useIncomingVerdict ? scene.videoMatching : match.videoMatching,
      videoCheckedAt: useIncomingVerdict ? scene.videoCheckedAt : match.videoCheckedAt,
      contributingSourceIds: [...contributors.get(match)!],
    });
    match.videoUrls = match.videoUrls.filter(
      (link) => !match.deadVideoUrls.some((dead) => dead.url === link.url),
    );
    if (!match.videoUrls.length) match.videoMatching = null;
    index(match);
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
