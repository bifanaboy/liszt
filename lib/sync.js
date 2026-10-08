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
import { Scene, parseAtBoundary } from "./schema.js";
import { mapIsolated, mapWithConcurrency } from "./concurrency.js";
import { resolveLinks, emptyRejections } from "./tubes/resolve.js";
import { reverifyLinks, createLinkVerifier } from "./tubes/reverify.js";
import { releaseIdentity } from "./release-identity.js";
import { mergeRelease } from "./release-merge.js";
import { getStudioMetadataProfile, scrapeReleaseMetadata } from "./sources/studio-metadata.js";
import { logProviderFailure, sanitizeFailureSummary } from "./logging.js";
/** `YYYY-MM-DD` from a `Date`, in UTC. */
export function dateOnly(date) {
  return date.toISOString().slice(0, 10);
}
/** Upsert one source's health, preserving fields a failed lane must not lose. */
async function recordSourceSuccess(store, adapter, sceneCount, now, windowDays, labels = []) {
  await store.upsertSource({
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
    await store.upsertSource({
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
async function recordSourceFailure(store, adapter, message, windowDays) {
  const statuses = (await store.listSources()).filter((status) => status.sourceId === adapter.id);
  const success = statuses.find((status) => status.labelId === adapter.id);
  await store.upsertSource({
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
    lastSuccessAt: success?.lastSuccessAt ?? null,
    lastError: message,
    sceneCount: success?.sceneCount ?? 0,
  });
  for (const child of statuses.filter((status) => status.labelId !== adapter.id)) {
    await store.upsertSource({
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
 * processed won and the other label's record was lost. Umbrella labels retain
 * a stable provider studio key, so changing display identity does not re-key
 * the provider's stored record.
 */
export function sceneKey(adapter, record) {
  const labelId = record.providerStudioId ?? record.studioId ?? adapter.id;
  return labelId === adapter.id
    ? `${adapter.id}:${record.sourceSceneId}`
    : `${adapter.id}:${labelId}:${record.sourceSceneId}`;
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
export function normaliseScene(adapter, record, now, previous, studioMetadataCheckedAt) {
  const labelId = record.studioId ?? adapter.id;
  const id = sceneKey(adapter, record);
  const provenance = record.provenance;
  const candidate = {
    id,
    sourceId: adapter.id,
    source: record.source ?? adapter.name,
    labelId,
    label: record.studio ?? adapter.name,
    title: record.title,
    performers: record.performers,
    releaseDate: record.releaseDate,
    durationSec: record.durationSec ?? null,
    ...(record.durationRange ? { durationRange: record.durationRange } : {}),
    durationReview: record.durationReview ?? false,
    thumbnailUrl: record.thumbnailUrl ?? "",
    tags: record.tags ?? [],
    videoUrls: previous?.videoUrls ?? [],
    deadVideoUrls: previous?.deadVideoUrls ?? [],
    videoCheckedAt: previous?.videoCheckedAt ?? null,
    videoMatching: previous?.videoMatching ?? null,
    studioMetadataCheckedAt: studioMetadataCheckedAt ?? previous?.studioMetadataCheckedAt ?? null,
    provenance: [
      {
        source: provenance?.source ?? record.source ?? adapter.name,
        fetchedAt: now.toISOString(),
        ...(provenance?.sourceUrl ? { sourceUrl: provenance.sourceUrl } : {}),
        ...(provenance?.recordUrl ? { recordUrl: provenance.recordUrl } : {}),
        sourceSceneId: provenance?.sourceSceneId ?? record.sourceSceneId,
        ...(provenance?.audit ? { audit: provenance.audit } : {}),
      },
    ],
    fieldProvenance: record.fieldProvenance ?? {},
    metadataPoor: record.metadataPoor ?? false,
    studioIdentityMissing: record.studioIdentityMissing ?? false,
  };
  for (const field of ["storeId", "launchDate", "previewUrl", "price"]) {
    if (record[field] !== undefined) candidate[field] = record[field];
  }
  if (record.releaseUrl) candidate.releaseUrl = record.releaseUrl;
  if (record.studioCode) candidate.studioCode = record.studioCode;
  return parseAtBoundary(Scene, candidate, `sync.scene(${id})`);
}
const MERGE_FIELDS = [
  "title",
  "releaseDate",
  "performers",
  "durationSec",
  "thumbnailUrl",
  "releaseUrl",
  "tags",
  "storeId",
  "launchDate",
  "previewUrl",
  "price",
  "studioCode",
];
function sourcePolicy(sources) {
  const priority = {};
  for (const field of MERGE_FIELDS) priority[field] = sources.map((source) => source.id);
  return { priority };
}
function canonicalStudio(id) {
  return id === "tpdb-maximogarcia" || id === "manyvids-1003095958" ? "maximo-garcia" : id;
}
function assignedStudio(observation) {
  return canonicalStudio(observation.record.studioId ?? observation.studioId);
}
function mergeHistory(scene, history) {
  const dead = new Map();
  const live = new Map();
  for (const record of history) {
    for (const link of record.deadVideoUrls) dead.set(link.url, link);
    for (const link of record.videoUrls) live.set(link.url, link);
  }
  scene.deadVideoUrls = [...dead.values()];
  scene.videoUrls = [...live.values()].filter((link) => !dead.has(link.url));
  scene.videoCheckedAt =
    history
      .map((record) => record.videoCheckedAt)
      .filter((value) => value !== null)
      .sort()[0] ?? null;
  scene.videoMatching = scene.videoUrls.length
    ? (history.find((record) => record.videoMatching)?.videoMatching ?? null)
    : null;
}
/** Persist one row for every verified release identity across provider observations. */
export async function reconcileReleases(store, sources, from, to, now, establishedIds = new Set()) {
  const scenes = await store.listWindow(from, to);
  const existing = new Map(scenes.map((scene) => [scene.id, scene]));
  const records = (await store.listProviderObservations()).filter((record) =>
    existing.has(record.sceneId),
  );
  const clusters = new Map();
  for (const record of records) {
    const identity = releaseIdentity(record.record);
    const title = record.record.title.toLowerCase().replace(/[^a-z0-9]/g, "");
    const duration = record.record.studioMetadata?.fields.durationSec ?? record.record.durationSec;
    const key =
      assignedStudio(record) === "maximo-garcia" &&
      title &&
      Number.isSafeInteger(duration) &&
      duration > 0
        ? JSON.stringify(["maximo-title", assignedStudio(record), title])
        : identity
          ? JSON.stringify(["url", assignedStudio(record), identity])
          : JSON.stringify([record.providerId, record.studioId, record.recordId]);
    const cluster = clusters.get(key) ?? [];
    cluster.push(record);
    clusters.set(key, cluster);
  }
  const policy = sourcePolicy(sources);
  const rank = new Map(sources.map((source, index) => [source.id, index]));
  for (const cluster of clusters.values()) {
    const linked = cluster.every((record) => releaseIdentity(record.record));
    const maximo = cluster.every((record) => assignedStudio(record) === "maximo-garcia");
    if (cluster.length > 1 && (maximo || !linked)) {
      const counts = new Map();
      for (const record of cluster) {
        counts.set(record.providerId, (counts.get(record.providerId) ?? 0) + 1);
      }
      if (counts.size < 2 || [...counts.values()].some((count) => count > 1)) continue;
    }
    const ids = [...new Set(cluster.map((record) => record.sceneId))];
    const stored = ids.map((id) => existing.get(id)).filter((scene) => Boolean(scene));
    if (!stored.length) continue;
    stored.sort(
      (first, second) =>
        Number(establishedIds.has(second.id)) - Number(establishedIds.has(first.id)) ||
        second.videoUrls.length - first.videoUrls.length ||
        (rank.get(first.sourceId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(second.sourceId) ?? Number.MAX_SAFE_INTEGER) ||
        first.id.localeCompare(second.id),
    );
    const canonical = stored[0];
    const lead = [...cluster].sort(
      (left, right) =>
        (rank.get(left.providerId) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.providerId) ?? Number.MAX_SAFE_INTEGER) ||
        left.providerId.localeCompare(right.providerId) ||
        left.recordId.localeCompare(right.recordId),
    )[0];
    const source = sources.find((candidate) => candidate.id === canonical.sourceId) ??
      sources.find((candidate) => candidate.id === lead.providerId) ?? {
        id: canonical.sourceId,
        name: canonical.source,
        authority: { name: canonical.source, url: "", role: "Provider observation" },
        matcher: null,
        fetch: async () => ({ scenes: [], verifiedEmpty: true }),
      };
    const durations = cluster.map((record) => record.record.durationSec);
    const measured = durations.filter(
      (duration) => Number.isSafeInteger(duration) && (duration ?? 0) > 0,
    );
    const sameDuration =
      measured.length > 0 && measured.every((duration) => duration === measured[0]);
    const mergePolicy = {
      ...policy,
      oldestDate:
        cluster.every((record) => assignedStudio(record) === "maximo-garcia") && sameDuration,
    };
    const release = mergeRelease(cluster, mergePolicy);
    if (maximo) {
      release.studioId = "maximo-garcia";
      release.studio = "Maximo Garcia";
    }
    const scene = normaliseScene(source, release, now, canonical);
    scene.id = canonical.id;
    scene.sourceId = canonical.sourceId;
    scene.source = canonical.source;
    scene.provenance = cluster.flatMap((record) => [
      {
        source: record.providerId,
        fetchedAt: record.fetchedAt,
        sourceSceneId: record.recordId,
        ...(record.record.provenance?.sourceUrl
          ? { sourceUrl: record.record.provenance.sourceUrl }
          : {}),
        ...((record.record.provenance?.recordUrl ?? record.record.releaseUrl)
          ? { recordUrl: record.record.provenance?.recordUrl ?? record.record.releaseUrl }
          : {}),
        ...(record.record.provenance?.audit ? { audit: record.record.provenance.audit } : {}),
      },
      ...(record.record.studioMetadata?.provenance
        ? [
            {
              source: "studio-site",
              fetchedAt: record.record.studioMetadata.fetchedAt,
              sourceSceneId: record.recordId,
              ...(record.record.studioMetadata.provenance.sourceUrl
                ? { sourceUrl: record.record.studioMetadata.provenance.sourceUrl }
                : {}),
              ...(record.record.studioMetadata.provenance.recordUrl
                ? { recordUrl: record.record.studioMetadata.provenance.recordUrl }
                : {}),
            },
          ]
        : []),
    ]);
    mergeHistory(scene, stored);
    await store.upsertScene(scene);
    await store.reassignProviderObservations(ids, canonical.id);
    for (const sceneId of ids) {
      if (sceneId !== canonical.id) await store.deleteScene(sceneId);
    }
  }
}
const STUDIO_RETRY_MS = 24 * 60 * 60 * 1000;
/** The most studio release pages one cycle reads, across every source. */
const STUDIO_LOOKUP_LIMIT = 50;
/** Merge one exact-page result without losing verified studio fields on later polls. */
export function mergeStudioMetadata(record, page, previous) {
  const output = { ...record };
  const fields = ["title", "releaseDate", "performers", "durationSec", "thumbnailUrl", "tags"];
  for (const field of fields) {
    if (page?.[field] !== undefined && page[field] !== null) {
      Object.assign(output, { [field]: page[field] });
      continue;
    }
    if (
      record.fieldProvenance?.[field] !== "studio-site" &&
      previous?.fieldProvenance[field] === "studio-site"
    ) {
      Object.assign(output, { [field]: previous[field] });
    }
  }
  output.fieldProvenance = {
    ...previous?.fieldProvenance,
    ...record.fieldProvenance,
    ...page?.fieldProvenance,
  };
  // Preserve the current catalogue record as the required provenance entry;
  // page provenance is appended by the caller after normalization.
  output.provenance = record.provenance;
  output.metadataPoor =
    Boolean(record.metadataPoor) ||
    (!output.durationRange && (!output.durationSec || output.durationSec <= 0));
  return output;
}
function sourceContext(adapter, { fetcher, now, log, traxxx, concurrency }) {
  return {
    fetcher,
    now,
    log: (message, fields) => log.debug(message, { source: adapter.id, ...fields }),
    ...(traxxx ? { traxxx } : {}),
    mapWithConcurrency: (items, task) => mapWithConcurrency(items, task, concurrency),
    mapIsolated: (items, task) => mapIsolated(items, task, concurrency),
  };
}
/**
 * Build the cycle runner. The returned function performs exactly one sync and
 * is safe to await from both the scheduler and `POST /api/refresh`; the caller
 * is responsible for single-flight coalescing.
 */
export function createSync(options) {
  const { store, sources, fetcher, clock, log, windowDays, fetchConcurrency } = options;
  const retiredSourceIds = options.retiredSourceIds ?? [];
  const progress = options.progress;
  const resolveEnabled = options.resolveEnabled ?? true;
  const laneBySource = new Map(
    sources.map((adapter) => [
      adapter.id,
      { matcher: adapter.matcher, creatorStudio: adapter.creatorStudio ?? false },
    ]),
  );
  return async function runSync(reason) {
    const now = clock.now();
    const to = dateOnly(now);
    const from = dateOnly(new Date(now.getTime() - windowDays * 86_400_000));
    const runId = `sync-${now.getTime()}-${globalThis.crypto.randomUUID().slice(0, 8)}`;
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
      await store.recordRun({
        id: runId,
        kind: "sync",
        startedAt,
        endedAt: null,
        outcomes: [],
        ok: null,
        error: null,
      });
      const retiredScenes = await store.pruneScenesForUnknownSources(retiredSourceIds);
      if (retiredScenes) {
        log.info("sync: retired source rows removed", {
          count: retiredScenes,
          sources: retiredSourceIds,
        });
      }
      log.info("sync started", { runId, reason, window: { from, to } });
      const establishedIds = new Set((await store.listWindow(from, to)).map((scene) => scene.id));
      const outcomes = await fanOut(from, now, runId);
      await reconcileReleases(store, sources, from, to, now, establishedIds);
      const { matched, resolved, reverified, rejections, winners, expired, windowScenes } =
        await linkAndTally(from, to, now);
      return await tally(
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
  /**
   * Phase 1: every source, in isolation, one completion per configured adapter.
   *
   * Sources are fetched first and stored afterwards, because the studio lookup
   * budget is spent across the whole cycle. Slicing it inside each adapter
   * would hand it to whichever source answers first, and a source that had
   * never been checked would wait behind another source's due retries.
   */
  async function fanOut(from, now, runId) {
    progress?.stage("populating");
    const observations = await store.listProviderObservations();
    const results = await mapWithConcurrency(
      [...sources],
      async (adapter) => {
        progress?.sourceStart(adapter.id);
        try {
          const result = await adapter.fetch(
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
          return {
            ok: true,
            adapter,
            result,
            existing: await existingFor(adapter, result, observations),
            pages: new Map(),
            checkedAt: new Map(),
          };
        } catch (error) {
          const message = sanitizeFailureSummary(
            error?.message ?? "Source request failed",
            options.logSecrets ?? [],
          );
          await recordSourceFailure(store, adapter, message, windowDays);
          logProviderFailure(
            {
              runId,
              provider: adapter.id,
              stage: "fetch",
              occurredAt: now.toISOString(),
              summary: message,
            },
            { secrets: options.logSecrets ?? [] },
          );
          return {
            ok: false,
            outcome: { source: adapter.id, ok: false, count: 0, error: message },
          };
        } finally {
          // An attempt, not a success: the meter has to reach its total even
          // when a source throws, or a failing source reads as a stalled
          // pipeline. Counted here because the store writes happen after
          // every source has been fetched, and the bar has to stay live.
          progress?.sourceDone(adapter.id);
        }
      },
      fetchConcurrency,
    );
    const fetched = results.filter((lane) => lane.ok);
    const outcomes = results.filter((lane) => !lane.ok).map((lane) => lane.outcome);
    // Store every provider observation before reconciling identities. A failed
    // provider never replaces its last-good observation, and one provider can
    // therefore contribute fields without suppressing another provider's data.
    await runStudioLookups(fetched, now);
    for (const lane of fetched) {
      let count = 0;
      try {
        for (const record of lane.result.scenes) {
          try {
            const previous = lane.existing.get(sceneKey(lane.adapter, record));
            const output = studioFieldsRetained(lane, record)
              ? mergeStudioMetadata(
                  record,
                  lane.pages.get(record) ?? null,
                  previousFor(record, previous),
                )
              : record;
            const scene = normaliseScene(
              lane.adapter,
              output,
              now,
              previous,
              lane.checkedAt.get(record),
            );
            scene.id = previous?.id ?? scene.id;
            if (previous && previous.sourceId !== lane.adapter.id) {
              scene.sourceId = previous.sourceId;
              scene.source = previous.source;
            }
            const provenance = [...(previous?.provenance ?? []), ...scene.provenance];
            const unique = new Map(
              provenance.map((item) => [
                `${item.source}|${item.sourceUrl ?? ""}|${item.recordUrl ?? ""}`,
                item,
              ]),
            );
            if (lane.pages.get(record)?.provenance) {
              const item = lane.pages.get(record).provenance;
              unique.set(`${item.source}|${item.sourceUrl ?? ""}|${item.recordUrl ?? ""}`, {
                ...item,
                fetchedAt: now.toISOString(),
              });
            }
            scene.provenance = [...unique.values()];
            await store.upsertScene(scene);
            await store.upsertProviderObservation({
              providerId: record.providerId ?? lane.adapter.id,
              recordId: record.sourceSceneId,
              sceneId: scene.id,
              studioId: record.providerStudioId ?? record.studioId ?? scene.labelId,
              studio: record.studio ?? scene.label,
              record: withStudioEvidence(
                record,
                lane.pages.get(record) ?? null,
                previous,
                now,
                record.source === "traxxx.me",
              ),
              fetchedAt: now.toISOString(),
            });
            count += 1;
          } catch (error) {
            log.warn("sync: skipped an invalid record", {
              source: lane.adapter.id,
              error: error.message,
            });
          }
        }
        // Only IDs the source positively excluded are deleted, and only from
        // this lane. Absence from `scenes` deletes nothing: a bounded run
        // that checked part of its queue must not remove the rest.
        await store.removeProviderRecords(lane.adapter.id, lane.result.excludedSceneIds ?? []);
        const excluded = new Map();
        for (const record of lane.result.excludedRecords ?? []) {
          excluded.set(record.providerId, [
            ...(excluded.get(record.providerId) ?? []),
            record.recordId,
          ]);
        }
        for (const [provider, recordIds] of excluded)
          await store.removeProviderRecords(provider, recordIds);
        await recordSourceSuccess(store, lane.adapter, count, now, windowDays, lane.result.labels);
        log.info("sync: source ok", {
          source: lane.adapter.id,
          count,
          verifiedEmpty: lane.result.verifiedEmpty,
        });
        outcomes.push({ source: lane.adapter.id, ok: true, count });
      } catch (error) {
        const message = sanitizeFailureSummary(
          error?.message ?? "Source result could not be saved",
          options.logSecrets ?? [],
        );
        await recordSourceFailure(store, lane.adapter, message, windowDays);
        logProviderFailure(
          {
            runId,
            provider: lane.adapter.id,
            stage: "persist",
            occurredAt: now.toISOString(),
            summary: message,
          },
          { secrets: options.logSecrets ?? [] },
        );
        outcomes.push({ source: lane.adapter.id, ok: false, count: 0, error: message });
      }
    }
    return outcomes;
  }
  /** One bulk read, not one per record: the stored links have to reach the upsert. */
  async function existingFor(adapter, result, observations) {
    const associations = result.scenes.map((record) => {
      const provider = record.providerId ?? adapter.id;
      const studio = record.providerStudioId ?? record.studioId ?? adapter.id;
      let observation = observations.find(
        (item) =>
          item.providerId === provider &&
          item.studioId === studio &&
          item.recordId === record.sourceSceneId,
      );
      if (!observation && provider.startsWith("tpdb-site-")) {
        const legacy = observations.filter(
          (item) =>
            item.recordId === record.sourceSceneId &&
            (item.providerId === provider || item.providerId === "tpdb-watchlist"),
        );
        if (legacy.length === 1) observation = legacy[0];
      }
      const key = sceneKey(adapter, record);
      return { key, id: observation?.sceneId ?? key };
    });
    const scenes = await store.getScenesByIds(associations.map((item) => item.id));
    return new Map(
      associations.flatMap(({ key, id }) => {
        const scene = scenes.get(id);
        return scene ? [[key, scene]] : [];
      }),
    );
  }
  /** The stored scene, minus fields a different studio page supplied. */
  function previousFor(record, previous) {
    const studioUrl = lastStudioUrl(previous);
    if (!previous || !record.releaseUrl || !studioUrl || studioUrl === record.releaseUrl) {
      return previous;
    }
    // The release URL changed, so the page that supplied these values is no
    // longer the page being asked about. Their provenance goes with them.
    const fieldProvenance = Object.fromEntries(
      Object.entries(previous.fieldProvenance).filter(([, value]) => value !== "studio-site"),
    );
    return { ...previous, fieldProvenance };
  }
  /** True when a studio-supplied field may be carried forward for this record. */
  function studioFieldsRetained(lane, record) {
    return lane.checkedAt.has(record) || record.source === "traxxx.me";
  }
  function withStudioEvidence(record, page, previous, now, traxxx) {
    if (page) {
      const fields = {};
      for (const field of [
        "title",
        "releaseDate",
        "performers",
        "durationSec",
        "thumbnailUrl",
        "tags",
      ]) {
        if (page[field] !== undefined) Object.assign(fields, { [field]: page[field] });
      }
      return {
        ...record,
        studioMetadata: {
          fields,
          provenance: page.provenance,
          fieldProvenance: page.fieldProvenance,
          fetchedAt: now.toISOString(),
        },
      };
    }
    if (previous && lastStudioUrl(previous) && record.releaseUrl !== lastStudioUrl(previous)) {
      return { ...record, studioMetadata: null };
    }
    if (traxxx && previous && Object.values(previous.fieldProvenance).includes("studio-site")) {
      const fields = {};
      for (const field of [
        "title",
        "releaseDate",
        "performers",
        "durationSec",
        "thumbnailUrl",
        "tags",
      ]) {
        if (previous.fieldProvenance[field] === "studio-site") {
          Object.assign(fields, { [field]: previous[field] });
        }
      }
      return {
        ...record,
        studioMetadata: {
          fields,
          provenance: previous.provenance.find((item) => item.source === "studio-site") ?? {
            source: "studio-site",
            ...(previous.releaseUrl ? { recordUrl: previous.releaseUrl } : {}),
          },
          fieldProvenance: previous.fieldProvenance,
          fetchedAt: previous.studioMetadataCheckedAt ?? now.toISOString(),
        },
      };
    }
    return record;
  }
  /** The release page that last supplied studio fields, or undefined. */
  function lastStudioUrl(scene) {
    return scene?.provenance.findLast(
      (item) => item.source === "studio-site" && Boolean(item.recordUrl),
    )?.recordUrl;
  }
  /** One studio lookup per selected record, in bounded parallel across lanes. */
  async function runStudioLookups(feeds, now) {
    const candidates = feeds
      .flatMap((feed) =>
        feed.result.scenes.flatMap((record) => {
          if (record.source !== "traxxx.me" || !record.releaseUrl) return [];
          const profile = getStudioMetadataProfile(record.releaseUrl);
          if (!profile) return [];
          const previous = feed.existing.get(sceneKey(feed.adapter, record));
          const attemptedAt = previous?.studioMetadataCheckedAt ?? null;
          // A release URL that no studio page has ever answered for has no
          // cooldown either: the recorded attempt describes a different page.
          const studioUrl = lastStudioUrl(previous);
          if (previous && studioUrl && studioUrl !== record.releaseUrl) {
            return [{ feed, record, previous, attemptedAt, profile }];
          }
          if (profile.fields.every((field) => previous?.fieldProvenance[field] === "studio-site")) {
            return [];
          }
          if (attemptedAt && now.getTime() - new Date(attemptedAt).getTime() < STUDIO_RETRY_MS) {
            return [];
          }
          return [{ feed, record, previous, attemptedAt, profile }];
        }),
      )
      .sort((a, b) => {
        // Never attempted first, then oldest attempt: the order the cycle
        // promises, decided once for every source rather than per adapter.
        if (!a.attemptedAt && b.attemptedAt) return -1;
        if (a.attemptedAt && !b.attemptedAt) return 1;
        if (!a.attemptedAt && !b.attemptedAt) {
          return a.record.releaseDate.localeCompare(b.record.releaseDate);
        }
        return (
          (a.attemptedAt ? Date.parse(a.attemptedAt) : 0) -
          (b.attemptedAt ? Date.parse(b.attemptedAt) : 0)
        );
      });
    const selected = candidates.slice(0, STUDIO_LOOKUP_LIMIT);
    const stamp = now.toISOString();
    for (const candidate of selected) {
      candidate.feed.checkedAt.set(candidate.record, stamp);
    }
    // Isolated, not the shared pool: a studio that is timing out must not hold
    // every other source's request behind it, and 50 serial lookups would add
    // half a minute to a cycle for no gain.
    await mapIsolated(
      selected,
      async ({ feed, record }) => {
        try {
          feed.pages.set(record, await scrapeReleaseMetadata(record.releaseUrl, fetcher));
        } catch (error) {
          feed.pages.set(record, null);
          log.warn("sync: studio metadata lookup failed; keeping catalogue values", {
            source: feed.adapter.id,
            scene: record.sourceSceneId,
            error: error.message,
          });
        }
      },
      fetchConcurrency,
    );
  }
  /** Phases 2 and 3: resolve the eligible scenes, then re-verify the stalest slice. */
  async function linkAndTally(from, to, now) {
    let matched = 0;
    let resolved = 0;
    let reverified = 0;
    const rejections = emptyRejections();
    const winners = [];
    if (resolveEnabled) {
      const before = await store.listWindow(from, to);
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
        fc2Lookup: options.lookups.fc2Lookup,
        log: options.log,
        ...(options.lookups.limit !== undefined ? { limit: options.lookups.limit } : {}),
        ...(progress
          ? {
              onProgress: (done, total, hit) => progress.linkStep(done, total, hit),
            }
          : {}),
      });
      matched = resolution.matched;
      resolved = resolution.considered;
      Object.assign(rejections, resolution.rejections);
      winners.push(...resolution.winners);
      for (const scene of resolution.changed) await store.upsertScene(scene);
      const verify = createLinkVerifier({ fetcher });
      progress?.stage("verifying");
      const reverifyResult = await reverifyLinks(await store.listWindow(from, to), {
        verify,
        now,
        ...(progress
          ? {
              onProgress: (done, total) =>
                done === 0 ? progress.verifyStart(total) : progress.verifyStep(done, total),
            }
          : {}),
      });
      reverified = reverifyResult.dead + reverifyResult.strikes;
      for (const scene of reverifyResult.changed) await store.upsertScene(scene);
    }
    progress?.stage("finishing");
    const expired = (await store.deleteReleasedBefore(from)).length;
    // Recompute per-source counts from the retained window so a source that
    // failed still shows its real in-window size rather than a stale number.
    const windowScenes = await store.listWindow(from, to);
    const bySourceId = new Map();
    const byLabelId = new Map();
    for (const scene of windowScenes) {
      bySourceId.set(scene.sourceId, (bySourceId.get(scene.sourceId) ?? 0) + 1);
      const labelKey = `${scene.sourceId}:${scene.labelId}`;
      byLabelId.set(labelKey, (byLabelId.get(labelKey) ?? 0) + 1);
    }
    for (const status of await store.listSources()) {
      await store.upsertSource({
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
  async function tally(run, counts) {
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
    await store.recordRun({
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
function winnerSplit(winners) {
  const split = { winnerPool: 0, winnerSxyprn: 0, winnerFallback: 0 };
  for (const winner of winners) {
    if (winner.rung === "fallback") split.winnerFallback += 1;
    else if (winner.rung === "sxyprn") split.winnerSxyprn += 1;
    else split.winnerPool += 1;
  }
  return split;
}
/** Winners per identity tier. A rising tier-0 share is the decoy signal. */
function tierHistogram(winners) {
  const histogram = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const winner of winners)
    histogram[String(winner.tier)] = (histogram[String(winner.tier)] ?? 0) + 1;
  return histogram;
}
