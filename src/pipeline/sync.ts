/**
 * The sync pipeline - one polling cycle.
 *
 * The order is the whole contract:
 *
 *   1. Fetch every source in isolation. One source that throws does not stop
 *      the others; it becomes a `RunOutcome` with `ok: false` and the source's
 *      last-good in-window rows are RETAINED (nothing deletes them).
 *   2. A source that returns no scenes without saying `verifiedEmpty` is
 *      treated as a suspicious extraction failure, not as an empty studio. This
 *      is what stops a parser bug from replacing data with silence.
 *   3. Normalise each raw record through the single `Scene` parse boundary and
 *      upsert by primary key, so a repeat sync converges instead of duplicating.
 *   4. Resolve playback links for eligible in-window scenes, then re-verify the
 *      stalest slice of existing links.
 *   5. Expire scenes that have left the rolling window, and record the run.
 *
 * Deletion only happens on window expiry. A scene missing from a successful
 * source response is kept until it leaves the window, which is the codex
 * snapshot bug this rebuild fixes.
 */
import { randomUUID } from "node:crypto";
import { Scene, parseAtBoundary, type RunOutcome } from "../core/schema.ts";
import { mapIsolated, mapWithConcurrency } from "../core/concurrency.ts";
import type { SqliteStore } from "../core/store/sqlite.ts";
import type { Logger } from "../core/logger.ts";
import type {
  Clock,
  Fetcher,
  RawScene,
  SourceAdapter,
  SourceContext,
  SourceResult,
} from "../sources/types.ts";
import { resolveLinks, emptyRejections, type RungRejections } from "../tubes/resolve.ts";
import { reverifyLinks, createLinkVerifier } from "../tubes/reverify.ts";
import type { EpornerOpenMatch } from "../tubes/eporner.ts";
import type { SxyprnMatch } from "../tubes/sxyprn.ts";
import type { PoolMatch } from "../tubes/eporner-pool.ts";
import type { IdentityTier } from "../core/matching.ts";
import type { MatchScene } from "../tubes/types.ts";

/** `YYYY-MM-DD` from a `Date`, in UTC. */
export function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Upsert one source's health, preserving fields a failed lane must not lose. */
function recordSourceSuccess(
  store: SqliteStore,
  adapter: SourceAdapter,
  sceneCount: number,
  now: Date,
): void {
  store.upsertSource({
    sourceId: adapter.id,
    labelId: adapter.id,
    name: adapter.name,
    label: adapter.name,
    authority: adapter.authority,
    creatorStudio: adapter.creatorStudio ?? false,
    windowDays: adapter.windowDays,
    matcher: adapter.matcher,
    lastSuccessAt: now.toISOString(),
    lastError: null,
    sceneCount,
  });
}

function recordSourceFailure(
  store: SqliteStore,
  adapter: SourceAdapter,
  message: string,
): void {
  const prior = store
    .listSources()
    .find((status) => status.sourceId === adapter.id && status.labelId === adapter.id);
  store.upsertSource({
    sourceId: adapter.id,
    labelId: adapter.id,
    name: adapter.name,
    label: adapter.name,
    authority: adapter.authority,
    creatorStudio: adapter.creatorStudio ?? false,
    windowDays: adapter.windowDays,
    matcher: adapter.matcher,
    // A failed poll keeps its prior success timestamp so "last success" stays
    // meaningful rather than being reset by a transient outage.
    lastSuccessAt: prior?.lastSuccessAt ?? null,
    lastError: message,
    sceneCount: prior?.sceneCount ?? 0,
  });
}

/**
 * The upsert key for one raw record: `<source-id>:<source-scene-id>`.
 *
 * The sub-label joins the key whenever it differs from the source id. A source
 * that emits several labels can emit the SAME post under more than one of them
 * (madouqu cross-lists posts into Madou, Jelly/91 and others), and with the
 * bare two-part key those records collided on one row - the last category
 * processed won and the other label's record was lost. Single-label sources
 * keep the historical two-part key, so existing rows stay put.
 */
export function sceneKey(adapter: SourceAdapter, raw: RawScene): string {
  const labelId = raw.studioId ?? adapter.id;
  return labelId === adapter.id
    ? `${adapter.id}:${raw.sourceSceneId}`
    : `${adapter.id}:${labelId}:${raw.sourceSceneId}`;
}

/**
 * Map one raw record to the canonical scene, keyed by `sceneKey`; a sub-label
 * (`studioId`/`studio`) becomes `labelId`/`label`, and provenance is always
 * present.
 *
 * `previous` is the already-stored record for the same key, when there is one.
 * The resolver-OWNED fields - live links, dead links, `videoCheckedAt` and
 * `videoMatching` - are carried from it verbatim and are never derived from a
 * source poll: a metadata source knows nothing about playback, so a scene built
 * without them would hand `upsertScene` an empty link set and erase every
 * resolved and every dead link on every poll. The same carry-over keeps
 * `videoCheckedAt` intact, so re-verify still rotates over the genuinely
 * stalest links instead of restarting the rotation each cycle.
 */
export function normaliseScene(
  adapter: SourceAdapter,
  raw: RawScene,
  now: Date,
  previous?: Scene,
): Scene {
  const labelId = raw.studioId ?? adapter.id;
  const id = sceneKey(adapter, raw);
  const provenance = raw.provenance;
  const candidate: Record<string, unknown> = {
    id,
    sourceId: adapter.id,
    source: raw.source ?? adapter.name,
    labelId,
    label: raw.studio ?? adapter.name,
    title: raw.title,
    performers: raw.performers,
    releaseDate: raw.releaseDate,
    durationSec: raw.durationSec ?? null,
    thumbnailUrl: raw.thumbnailUrl ?? "",
    tags: raw.tags ?? [],
    videoUrls: previous?.videoUrls ?? [],
    deadVideoUrls: previous?.deadVideoUrls ?? [],
    videoCheckedAt: previous?.videoCheckedAt ?? null,
    videoMatching: previous?.videoMatching ?? null,
    provenance: [
      {
        source: provenance?.source ?? raw.source ?? adapter.name,
        fetchedAt: now.toISOString(),
        ...(provenance?.sourceUrl ? { sourceUrl: provenance.sourceUrl } : {}),
        ...(provenance?.recordUrl ? { recordUrl: provenance.recordUrl } : {}),
        sourceSceneId: provenance?.sourceSceneId ?? raw.sourceSceneId,
        ...(provenance?.audit ? { audit: provenance.audit } : {}),
      },
    ],
    fieldProvenance: raw.fieldProvenance ?? {},
    metadataPoor: raw.metadataPoor ?? false,
  };
  if (raw.releaseUrl) candidate.releaseUrl = raw.releaseUrl;
  if (raw.studioCode) candidate.studioCode = raw.studioCode;
  return parseAtBoundary(Scene, candidate, `sync.scene(${id})`);
}

export interface SyncLookups {
  poolLookup: ((scene: MatchScene, now: Date) => Promise<PoolMatch | null>) | null;
  sxyprnLookup: ((scene: MatchScene) => Promise<SxyprnMatch[]>) | null;
  openLookup: ((scene: MatchScene) => Promise<EpornerOpenMatch[]>) | null;
  /** Optional cap on scenes resolved per cycle. */
  limit?: number;
}

export interface SyncOptions {
  store: SqliteStore;
  sources: readonly SourceAdapter[];
  fetcher: Fetcher;
  clock: Clock;
  log: Logger;
  windowDays: number;
  fetchConcurrency: number;
  traxxx?: { minIntervalMs?: number; cacheTtlMs?: number };
  lookups: SyncLookups;
  /** Skip the resolve/re-verify stages entirely (used by `--no-links` runs). */
  resolveEnabled?: boolean;
}

export interface SyncSummary {
  runId: string;
  startedAt: string;
  endedAt: string;
  ok: boolean;
  outcomes: RunOutcome[];
  window: { from: string; to: string; days: number };
  windowScenes: number;
  matched: number;
  resolved: number;
  reverified: number;
  expired: number;
  /** Per-rung rejection counts, so a mis-tuned gate is visible in the log. */
  rejections: RungRejections;
  /** Identity tier of each winner, for the tier histogram. */
  tiers: IdentityTier[];
}

function sourceContext(
  adapter: SourceAdapter,
  {
    fetcher,
    now,
    log,
    traxxx,
    concurrency,
  }: {
    fetcher: Fetcher;
    now: Date;
    log: Logger;
    traxxx?: SyncOptions["traxxx"];
    concurrency: number;
  },
): SourceContext {
  return {
    fetcher,
    now,
    log: (message, fields) => log.debug(message, { source: adapter.id, ...fields }),
    ...(traxxx ? { traxxx } : {}),
    mapWithConcurrency: <T, R>(items: T[], task: (item: T, index: number) => Promise<R>) =>
      mapWithConcurrency(items, task, concurrency),
    mapIsolated: <T, R>(items: T[], task: (item: T, index: number) => Promise<R>) =>
      mapIsolated(items, task, concurrency),
  };
}

/**
 * Build the cycle runner. The returned function performs exactly one sync and
 * is safe to await from both the scheduler and `POST /api/refresh`; the caller
 * is responsible for single-flight coalescing.
 */
export function createSync(options: SyncOptions): (reason: string) => Promise<SyncSummary> {
  const { store, sources, fetcher, clock, log, windowDays, fetchConcurrency } = options;
  const resolveEnabled = options.resolveEnabled ?? true;
  const laneBySource = new Map(
    sources.map((adapter) => [
      adapter.id,
      { matcher: adapter.matcher, creatorStudio: adapter.creatorStudio ?? false },
    ]),
  );

  return async function runSync(reason: string): Promise<SyncSummary> {
    const now = clock.now();
    const to = dateOnly(now);
    const from = dateOnly(new Date(now.getTime() - windowDays * 86_400_000));
    const runId = `sync-${now.getTime()}-${randomUUID().slice(0, 8)}`;
    const startedAt = now.toISOString();
    store.recordRun({ id: runId, kind: "sync", startedAt, endedAt: null, outcomes: [], ok: null, error: null });
    log.info("sync started", { runId, reason, window: { from, to } });

    const outcomes = await mapWithConcurrency(
      [...sources],
      async (adapter): Promise<RunOutcome> => {
        try {
          const result: SourceResult = await adapter.fetch(
            from,
            sourceContext(adapter, { fetcher, now, log, traxxx: options.traxxx, concurrency: fetchConcurrency }),
          );
          if (!result.scenes.length && !result.verifiedEmpty) {
            throw new Error(
              "returned no scenes without asserting an empty source (suspicious extraction failure)",
            );
          }
          let count = 0;
          // One bulk read, not one per record: the stored links have to reach
          // `normaliseScene` so the metadata upsert preserves them.
          const existing = store.getScenesByIds(
            result.scenes.map((raw) => sceneKey(adapter, raw)),
          );
          for (const raw of result.scenes) {
            try {
              const previous = existing.get(sceneKey(adapter, raw));
              store.upsertScene(normaliseScene(adapter, raw, now, previous));
              count += 1;
            } catch (error) {
              log.warn("sync: skipped an invalid record", {
                source: adapter.id,
                error: (error as Error).message,
              });
            }
          }
          recordSourceSuccess(store, adapter, count, now);
          log.info("sync: source ok", { source: adapter.id, count, verifiedEmpty: result.verifiedEmpty });
          return { source: adapter.id, ok: true, count };
        } catch (error) {
          const message = (error as Error).message;
          recordSourceFailure(store, adapter, message);
          log.error("sync: source failed, retaining last-good records", {
            source: adapter.id,
            error: message,
          });
          return { source: adapter.id, ok: false, count: 0, error: message };
        }
      },
      fetchConcurrency,
    );

    let matched = 0;
    let resolved = 0;
    let reverified = 0;
    const rejections = emptyRejections();
    const tiers: IdentityTier[] = [];

    if (resolveEnabled) {
      const before = store.listWindow(from, to);
      const resolution = await resolveLinks({
        scenes: before,
        now,
        mapWithConcurrency: (items, task) => mapWithConcurrency(items, task, fetchConcurrency),
        matcherFor: (scene) =>
          laneBySource.get(scene.sourceId) ?? { matcher: null, creatorStudio: false },
        poolLookup: options.lookups.poolLookup,
        sxyprnLookup: options.lookups.sxyprnLookup,
        openLookup: options.lookups.openLookup,
        ...(options.lookups.limit !== undefined ? { limit: options.lookups.limit } : {}),
      });
      matched = resolution.matched;
      resolved = resolution.considered;
      Object.assign(rejections, resolution.rejections);
      tiers.push(...resolution.tiers);
      for (const scene of resolution.changed) store.upsertScene(scene);

      const verify = createLinkVerifier({ fetcher });
      const reverifyResult = await reverifyLinks(store.listWindow(from, to), { verify, now });
      reverified = reverifyResult.dead + reverifyResult.strikes;
      for (const scene of reverifyResult.changed) store.upsertScene(scene);
    }

    const expired = store.deleteReleasedBefore(from).length;

    // Recompute per-source counts from the retained window so a source that
    // failed still shows its real in-window size rather than a stale number.
    const windowScenes = store.listWindow(from, to);
    const counts = new Map<string, number>();
    for (const scene of windowScenes) counts.set(scene.sourceId, (counts.get(scene.sourceId) ?? 0) + 1);
    for (const status of store.listSources()) {
      store.upsertSource({
        sourceId: status.sourceId,
        labelId: status.labelId,
        name: status.name,
        label: status.label,
        authority: status.authority,
        creatorStudio: status.creatorStudio,
        windowDays: status.windowDays,
        matcher: status.matcher,
        lastSuccessAt: status.lastSuccessAt,
        lastError: status.lastError,
        sceneCount: counts.get(status.sourceId) ?? 0,
      });
    }

    const endedAt = clock.now().toISOString();
    const ok = outcomes.every((outcome) => outcome.ok);
    const error = outcomes.find((outcome) => !outcome.ok)?.error ?? null;
    store.recordRun({ id: runId, kind: "sync", startedAt, endedAt, outcomes, ok, error });
    // The tier histogram and the rejection counts go in the log, not just the
    // summary: the decoy path and a mis-tuned window are both invisible in a
    // match count, and both are cheap to spot here.
    log.info("sync finished", {
      runId, ok, matched, resolved, reverified, expired,
      windowScenes: windowScenes.length,
      rejections,
      tiers: tierHistogram(tiers),
    });

    return {
      runId,
      startedAt,
      endedAt,
      ok,
      outcomes,
      window: { from, to, days: windowDays },
      windowScenes: windowScenes.length,
      matched,
      resolved,
      reverified,
      expired,
      rejections,
      tiers,
    };
  };
}

/** Winners per identity tier. A rising tier-0 share is the decoy signal. */
function tierHistogram(tiers: readonly IdentityTier[]): Record<string, number> {
  const histogram: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0 };
  for (const tier of tiers) histogram[String(tier)] = (histogram[String(tier)] ?? 0) + 1;
  return histogram;
}