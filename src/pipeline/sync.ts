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
  SourceLabel,
  SourceResult,
} from "../sources/types.ts";
import {
  resolveLinks,
  emptyRejections,
  type RungRejections,
  type Winner,
} from "../tubes/resolve.ts";
import { reverifyLinks, createLinkVerifier } from "../tubes/reverify.ts";
import type { ProgressTracker } from "./progress.ts";
import type { SxyprnMatch, SxyprnRequestCount } from "../tubes/sxyprn.ts";
import type { PoolMatch } from "../tubes/eporner-pool.ts";
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
  windowDays: number,
  labels: readonly SourceLabel[] = [],
): void {
  store.upsertSource({
    sourceId: adapter.id,
    labelId: adapter.id,
    name: adapter.name,
    label: adapter.name,
    authority: adapter.authority,
    creatorStudio: adapter.creatorStudio ?? false,
    windowDays,
    matcher: adapter.matcher,
    lastSuccessAt: now.toISOString(),
    lastError: null,
    sceneCount,
  });
  for (const child of labels) {
    // Never trust Traxxx's network URL here: observed payloads contain the
    // literal string "!undefined". Child rows inherit the validated lane
    // authority object verbatim instead.
    store.upsertSource({
      sourceId: adapter.id,
      labelId: child.labelId,
      name: adapter.name,
      label: child.label,
      authority: adapter.authority,
      creatorStudio: adapter.creatorStudio ?? false,
      windowDays,
      matcher: adapter.matcher,
      lastSuccessAt: now.toISOString(),
      lastError: null,
      sceneCount: child.sceneCount,
    });
  }
}

function recordSourceFailure(
  store: SqliteStore,
  adapter: SourceAdapter,
  message: string,
  windowDays: number,
): void {
  const priorRows = store.listSources().filter((status) => status.sourceId === adapter.id);
  const prior = priorRows.find((status) => status.labelId === adapter.id);
  store.upsertSource({
    sourceId: adapter.id,
    labelId: adapter.id,
    name: adapter.name,
    label: adapter.name,
    authority: adapter.authority,
    creatorStudio: adapter.creatorStudio ?? false,
    windowDays,
    matcher: adapter.matcher,
    // A failed poll keeps its prior success timestamp so "last success" stays
    // meaningful rather than being reset by a transient outage.
    lastSuccessAt: prior?.lastSuccessAt ?? null,
    lastError: message,
    sceneCount: prior?.sceneCount ?? 0,
  });
  for (const child of priorRows.filter((status) => status.labelId !== adapter.id)) {
    store.upsertSource({
      sourceId: adapter.id,
      labelId: child.labelId,
      name: adapter.name,
      label: child.label,
      authority: adapter.authority,
      creatorStudio: adapter.creatorStudio ?? false,
      windowDays,
      matcher: adapter.matcher,
      lastSuccessAt: child.lastSuccessAt,
      lastError: message,
      sceneCount: child.sceneCount,
    });
  }
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
  studioMetadataCheckedAt?: string | null,
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
    studioMetadataCheckedAt: studioMetadataCheckedAt ?? previous?.studioMetadataCheckedAt ?? null,
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
  for (const field of ["storeId", "launchDate", "previewUrl", "price"] as const) {
    if (raw[field] !== undefined) candidate[field] = raw[field];
  }
  if (raw.releaseUrl) candidate.releaseUrl = raw.releaseUrl;
  if (raw.studioCode) candidate.studioCode = raw.studioCode;
  return parseAtBoundary(Scene, candidate, `sync.scene(${id})`);
}

export interface SyncLookups {
  poolLookup: ((scene: MatchScene, now: Date) => Promise<PoolMatch | null>) | null;
  sxyprnLookup: ((scene: MatchScene) => Promise<SxyprnMatch[]>) | null;
  /** Optional cap on scenes resolved per cycle. */
  limit?: number;
  /**
   * Drain the sxyprn client's request counter, for the ledger. Optional, and
   * absent when the optional package is not installed.
   *
   * A drain rather than a total, and called once per cycle, so a run is charged
   * only for the requests it made itself - a total would make every refresh
   * inherit the sum of all the ones before it (#71).
   */
  sxyprnRequests?: () => SxyprnRequestCount;
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
  /**
   * Optional live-progress sink. The cycle narrates itself into it as it works;
   * nothing about the run's OUTCOME depends on it, and `SyncSummary` is
   * unchanged, so a missing tracker is a quiet no-op rather than a failure.
   *
   * `begin()` is called here rather than by the caller, because the run id and
   * start time are minted here - a tracker started outside would have to
   * duplicate both and could drift from the ledger row they describe.
   */
  progress?: ProgressTracker;
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
  /** Which rung produced each winner, with its tier, for the winner split. */
  winners: Winner[];
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
  const progress = options.progress;
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
    // The tracker is CYCLE-scoped and is begun by the composition root, before
    // the pool index - the index runs first and its progress must survive. A
    // direct caller that never began it (a test, or `createSync` used on its
    // own) would otherwise have every emission below dropped as not-active, so
    // the run is begun here instead. `begin()` is not called unconditionally:
    // doing that would wipe the indexing counters on every cycle.
    if (progress && !progress.snapshot().active) {
      progress.begin(runId, startedAt, { sources: sources.length, uploaders: 0 });
    }

    try {
      store.recordRun({
        id: runId,
        kind: "sync",
        startedAt,
        endedAt: null,
        outcomes: [],
        ok: null,
        error: null,
      });
      log.info("sync started", { runId, reason, window: { from, to } });
      const outcomes = await fanOut(from, now);
      const { matched, resolved, reverified, rejections, winners, expired, windowScenes } =
        await linkAndTally(from, to, now);
      return tally(
        { runId, startedAt, from, to, endedAt: clock.now().toISOString(), outcomes, rejections },
        { matched, resolved, reverified, expired, windowScenes, winners },
      );
    } catch (error) {
      // The counters stay where they stopped: a failed cycle should still be
      // able to say how far it got before it died.
      progress?.fail();
      throw error;
    }
  };

  /** Phase 1: every source, in isolation, one completion per configured adapter. */
  async function fanOut(from: string, now: Date): Promise<RunOutcome[]> {
    progress?.stage("populating");
    return mapWithConcurrency(
      [...sources],
      async (adapter): Promise<RunOutcome> => {
        progress?.sourceStart(adapter.id);
        let outcome: RunOutcome;
        try {
          const result: SourceResult = await adapter.fetch(
            from,
            sourceContext(adapter, {
              fetcher,
              now,
              log,
              traxxx: options.traxxx,
              concurrency: fetchConcurrency,
            }),
          );
          if (!result.scenes.length && !result.verifiedEmpty) {
            throw new Error(
              "returned no scenes without asserting an empty source (suspicious extraction failure)",
            );
          }
          let count = 0;
          // One bulk read, not one per record: the stored links have to reach
          // `normaliseScene` so the metadata upsert preserves them.
          const existing = store.getScenesByIds(result.scenes.map((raw) => sceneKey(adapter, raw)));
          store.transaction(() => {
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
            recordSourceSuccess(store, adapter, count, now, windowDays, result.labels);
          });
          log.info("sync: source ok", {
            source: adapter.id,
            count,
            verifiedEmpty: result.verifiedEmpty,
          });
          outcome = { source: adapter.id, ok: true, count };
        } catch (error) {
          const message = (error as Error).message;
          recordSourceFailure(store, adapter, message, windowDays);
          log.error("sync: source failed, retaining last-good records", {
            source: adapter.id,
            error: message,
          });
          outcome = { source: adapter.id, ok: false, count: 0, error: message };
        }
        // An attempt, not a success: the meter has to reach its total even when
        // a source throws, or a failing source reads as a stalled pipeline.
        progress?.sourceDone(adapter.id);
        return outcome;
      },
      fetchConcurrency,
    );
  }

  /** Phases 2 and 3: resolve the eligible scenes, then re-verify the stalest slice. */
  async function linkAndTally(
    from: string,
    to: string,
    now: Date,
  ): Promise<{
    matched: number;
    resolved: number;
    reverified: number;
    rejections: RungRejections;
    winners: Winner[];
    expired: number;
    windowScenes: Scene[];
  }> {
    let matched = 0;
    let resolved = 0;
    let reverified = 0;
    const rejections = emptyRejections();
    const winners: Winner[] = [];

    if (resolveEnabled) {
      const before = store.listWindow(from, to);
      progress?.stage("linking");
      // Seeded with the whole window, then corrected by `resolveLinks` to the
      // queue it actually built: eligibility filtering and `lookups.limit` both
      // shrink it, and a bar whose denominator moved would be a lie. The
      // correction lands in the same synchronous block, before any poll can
      // read the seed.
      progress?.linkStart(before.length);
      const resolution = await resolveLinks({
        scenes: before,
        now,
        mapWithConcurrency: (items, task) => mapWithConcurrency(items, task, fetchConcurrency),
        matcherFor: (scene) =>
          laneBySource.get(scene.sourceId) ?? { matcher: null, creatorStudio: false },
        poolLookup: options.lookups.poolLookup,
        sxyprnLookup: options.lookups.sxyprnLookup,
        log: options.log,
        ...(options.lookups.limit !== undefined ? { limit: options.lookups.limit } : {}),
        ...(progress
          ? {
              onProgress: (done: number, total: number, hit: number) =>
                progress.linkStep(done, total, hit),
            }
          : {}),
      });
      matched = resolution.matched;
      resolved = resolution.considered;
      Object.assign(rejections, resolution.rejections);
      winners.push(...resolution.winners);
      for (const scene of resolution.changed) store.upsertScene(scene);

      const verify = createLinkVerifier({ fetcher });
      progress?.stage("verifying");
      const reverifyResult = await reverifyLinks(store.listWindow(from, to), {
        verify,
        now,
        ...(progress
          ? {
              onProgress: (done: number, total: number) =>
                done === 0 ? progress.verifyStart(total) : progress.verifyStep(done, total),
            }
          : {}),
      });
      reverified = reverifyResult.dead + reverifyResult.strikes;
      for (const scene of reverifyResult.changed) store.upsertScene(scene);
    }

    progress?.stage("finishing");
    const expired = store.deleteReleasedBefore(from).length;

    // Recompute per-source counts from the retained window so a source that
    // failed still shows its real in-window size rather than a stale number.
    const windowScenes = store.listWindow(from, to);
    const bySourceId = new Map<string, number>();
    const byLabelId = new Map<string, number>();
    for (const scene of windowScenes) {
      bySourceId.set(scene.sourceId, (bySourceId.get(scene.sourceId) ?? 0) + 1);
      const labelKey = `${scene.sourceId}:${scene.labelId}`;
      byLabelId.set(labelKey, (byLabelId.get(labelKey) ?? 0) + 1);
    }
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
        sceneCount:
          status.labelId === status.sourceId
            ? (bySourceId.get(status.sourceId) ?? 0)
            : (byLabelId.get(`${status.sourceId}:${status.labelId}`) ?? 0),
      });
    }
    return { matched, resolved, reverified, rejections, winners, expired, windowScenes };
  }

  /** Phase 4: close the ledger row and hand back the summary. */
  function tally(
    run: {
      runId: string;
      startedAt: string;
      from: string;
      to: string;
      endedAt: string;
      outcomes: RunOutcome[];
      rejections: RungRejections;
    },
    counts: {
      matched: number;
      resolved: number;
      reverified: number;
      expired: number;
      windowScenes: Scene[];
      winners: Winner[];
    },
  ): SyncSummary {
    const { runId, startedAt, from, to, endedAt, outcomes, rejections } = run;
    const { matched, resolved, reverified, expired, windowScenes, winners } = counts;
    const ok = outcomes.every((outcome) => outcome.ok);
    const error = outcomes.find((outcome) => !outcome.ok)?.error ?? null;
    // Drained here, once, with the resolve stage over: the client is process-wide
    // and outlives the cycle, so this is the only place the count can still be
    // this run's alone. Sibling keys rather than fields on `RungRejections`,
    // whose counters describe the ladder as a whole and cannot be attributed to
    // one rung (#71). Flat, because `resolver_health` is read back as numbers.
    const sxyprnRequests = options.lookups.sxyprnRequests?.() ?? { search: 0, details: 0 };
    const split = winnerSplit(winners);
    store.recordRun({
      id: runId,
      kind: "sync",
      startedAt,
      endedAt,
      outcomes,
      ok,
      error,
      resolverHealth: {
        ...rejections,
        sxyprnSearches: sxyprnRequests.search,
        sxyprnDetails: sxyprnRequests.details,
        ...split,
      },
    });
    // The tier histogram and the rejection counts go in the log, not just the
    // summary: the decoy path and a mis-tuned window are both invisible in a
    // match count, and both are cheap to spot here.
    log.info("sync finished", {
      runId,
      ok,
      matched,
      resolved,
      reverified,
      expired,
      windowScenes: windowScenes.length,
      rejections,
      // The rung's cost in requests. Times the source's pacing floor, this is
      // how long the resolve stage had to take.
      sxyprnRequests,
      // `matched` counts a named match and a guess alike, so this is the split
      // that says how much of the headline number was actually identified.
      winners: split,
      tiers: tierHistogram(winners),
    });

    // The bar collapses here rather than waiting for the caller: the ledger row
    // is closed, so this is the end of the run as far as a reader is concerned.
    progress?.finish();

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
      winners,
    };
  }
}

/**
 * Winners by provenance, so a run row can say what `matched` counted.
 *
 * `matched` is one number over two different things: a rung that NAMED the scene,
 * and the terminal fallback's flagged guess when no tube could. Both are stored
 * as links, so the headline figure reads the same either way, and the only way
 * to tell them apart was to reconstruct it from other counters. These are the
 * direct reading. `winnerFallback` is the guess count; the other two are the
 * rungs' individual contributions, which nothing else on the row separates.
 */
function winnerSplit(winners: readonly Winner[]): Record<string, number> {
  const split = { winnerPool: 0, winnerSxyprn: 0, winnerFallback: 0 };
  for (const winner of winners) {
    if (winner.rung === "fallback") split.winnerFallback += 1;
    else if (winner.rung === "sxyprn") split.winnerSxyprn += 1;
    else split.winnerPool += 1;
  }
  return split;
}

/** Winners per identity tier. A rising tier-0 share is the decoy signal. */
function tierHistogram(winners: readonly Winner[]): Record<string, number> {
  const histogram: Record<string, number> = { "0": 0, "1": 0, "2": 0, "3": 0 };
  for (const winner of winners)
    histogram[String(winner.tier)] = (histogram[String(winner.tier)] ?? 0) + 1;
  return histogram;
}
