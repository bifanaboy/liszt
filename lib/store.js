import { toIsoUtc } from "./matching.js";

const json = (value) => JSON.stringify(value);

async function query(db, sql, params = []) {
  return db.query(sql, params);
}

function sceneFromRows(row, links) {
  const storefront = row.storefront ?? {};
  return {
    id: row.id,
    sourceId: row.source_id,
    source: row.source,
    labelId: row.label_id,
    label: row.label,
    ...storefront,
    title: row.title,
    performers: row.performers,
    releaseDate: row.release_date,
    durationSec: row.duration_sec,
    thumbnailUrl: row.thumbnail_url,
    ...(row.release_url == null ? {} : { releaseUrl: row.release_url }),
    ...(row.studio_code == null ? {} : { studioCode: row.studio_code }),
    tags: row.tags,
    provenance: row.provenance,
    fieldProvenance: row.field_provenance,
    metadataPoor: row.metadata_poor,
    studioMetadataCheckedAt: row.studio_metadata_checked_at,
    videoUrls: links
      .filter((link) => link.kind === "live")
      .map((link) => ({
        source: link.source,
        url: link.url,
        verifiedAt: link.verified_at,
        verifyFailures: Number(link.verify_failures ?? 0),
        ...(link.part == null ? {} : { part: Number(link.part) }),
      })),
    deadVideoUrls: links
      .filter((link) => link.kind === "dead")
      .map((link) => ({
        source: link.source,
        url: link.url,
        deadAt: link.dead_at,
        deadReason: link.dead_reason,
      })),
    videoCheckedAt: row.video_checked_at,
    videoMatching: row.video_matching,
  };
}

function validateScene(scene) {
  const date = new Date(`${scene.releaseDate}T00:00:00.000Z`);
  if (
    !scene.id ||
    !scene.sourceId ||
    !scene.source ||
    !scene.labelId ||
    !scene.title ||
    !/^\d{4}-\d{2}-\d{2}$/.test(scene.releaseDate) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== scene.releaseDate ||
    !Array.isArray(scene.performers) ||
    !Array.isArray(scene.tags) ||
    !Array.isArray(scene.provenance) ||
    !scene.provenance.length ||
    !Array.isArray(scene.videoUrls) ||
    !Array.isArray(scene.deadVideoUrls)
  ) {
    throw new TypeError(`Invalid scene at store boundary: ${scene.id ?? "unknown"}`);
  }
}

export function createStore(db) {
  const store = {
    query: (sql, params) => query(db, sql, params),
    transaction: (statements) => db.transaction(statements),

    async getSourceSnapshot(sourceId) {
      const { rows } = await query(
        db,
        "SELECT snapshot FROM source_snapshots WHERE source_id = $1",
        [sourceId],
      );
      return rows[0]?.snapshot ?? null;
    },
    async setSourceSnapshot(sourceId, snapshot) {
      await query(
        db,
        `INSERT INTO source_snapshots (source_id, snapshot) VALUES ($1, $2)
        ON CONFLICT (source_id) DO UPDATE SET snapshot = EXCLUDED.snapshot`,
        [sourceId, snapshot],
      );
    },
    async getScene(id) {
      const { rows } = await query(db, "SELECT * FROM scenes WHERE id = $1", [id]);
      if (!rows[0]) return null;
      const links = await query(db, "SELECT * FROM scene_links WHERE scene_id = $1", [id]);
      return sceneFromRows(rows[0], links.rows);
    },
    async getScenesByIds(ids) {
      if (!ids.length) return new Map();
      const { rows } = await query(db, "SELECT * FROM scenes WHERE id = ANY($1::text[])", [ids]);
      const links = await query(db, "SELECT * FROM scene_links WHERE scene_id = ANY($1::text[])", [
        rows.map((r) => r.id),
      ]);
      const grouped = new Map();
      for (const link of links.rows)
        grouped.set(link.scene_id, [...(grouped.get(link.scene_id) ?? []), link]);
      return new Map(rows.map((row) => [row.id, sceneFromRows(row, grouped.get(row.id) ?? [])]));
    },
    async listWindow(from, to) {
      const { rows } = await query(
        db,
        `SELECT * FROM scenes WHERE release_date >= $1 AND release_date <= $2
        ORDER BY release_date DESC, id ASC`,
        [from, to],
      );
      return hydrate(rows);
    },
    async listAll() {
      const { rows } = await query(db, "SELECT * FROM scenes ORDER BY release_date DESC, id ASC");
      return hydrate(rows);
    },
    async upsertScene(scene) {
      validateScene(scene);
      const storefront = Object.fromEntries(
        ["storeId", "launchDate", "previewUrl", "price", "durationRange", "durationReview"]
          .filter((key) => scene[key] !== undefined)
          .map((key) => [key, scene[key]]),
      );
      const statements = [
        {
          sql: `INSERT INTO scenes
        (id, source_id, source, label_id, label, title, performers, release_date, duration_sec,
         thumbnail_url, release_url, studio_code, tags, provenance, field_provenance, metadata_poor,
         studio_metadata_checked_at, video_checked_at, video_matching, storefront)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15::jsonb,$16,$17,$18,$19::jsonb,$20::jsonb)
        ON CONFLICT (id) DO UPDATE SET source_id=EXCLUDED.source_id, source=EXCLUDED.source,
        label_id=EXCLUDED.label_id, label=EXCLUDED.label, title=EXCLUDED.title, performers=EXCLUDED.performers,
        release_date=EXCLUDED.release_date, duration_sec=EXCLUDED.duration_sec, thumbnail_url=EXCLUDED.thumbnail_url,
        release_url=EXCLUDED.release_url, studio_code=EXCLUDED.studio_code, tags=EXCLUDED.tags,
        provenance=EXCLUDED.provenance, field_provenance=EXCLUDED.field_provenance, metadata_poor=EXCLUDED.metadata_poor,
        studio_metadata_checked_at=EXCLUDED.studio_metadata_checked_at, video_checked_at=EXCLUDED.video_checked_at,
        video_matching=EXCLUDED.video_matching, storefront=EXCLUDED.storefront`,
          params: [
            scene.id,
            scene.sourceId,
            scene.source,
            scene.labelId,
            scene.label,
            scene.title,
            json(scene.performers),
            scene.releaseDate,
            scene.durationSec,
            scene.thumbnailUrl,
            scene.releaseUrl ?? null,
            scene.studioCode ?? null,
            json(scene.tags),
            json(scene.provenance),
            json(scene.fieldProvenance),
            scene.metadataPoor,
            scene.studioMetadataCheckedAt,
            scene.videoCheckedAt,
            scene.videoMatching ? json(scene.videoMatching) : null,
            json(storefront),
          ],
        },
        { sql: "DELETE FROM scene_links WHERE scene_id = $1", params: [scene.id] },
      ];
      for (const link of scene.videoUrls)
        statements.push({
          sql: `INSERT INTO scene_links
        (scene_id,kind,source,url,verified_at,verify_failures,dead_at,dead_reason,part)
        VALUES ($1,'live',$2,$3,$4,$5,NULL,NULL,$6)`,
          params: [
            scene.id,
            link.source,
            link.url,
            link.verifiedAt,
            link.verifyFailures,
            link.part ?? null,
          ],
        });
      for (const link of scene.deadVideoUrls)
        statements.push({
          sql: `INSERT INTO scene_links
        (scene_id,kind,source,url,verified_at,verify_failures,dead_at,dead_reason,part)
        VALUES ($1,'dead',$2,$3,NULL,0,$4,$5,NULL)`,
          params: [scene.id, link.source, link.url, link.deadAt, link.deadReason],
        });
      await db.transaction(statements);
    },
    async deleteScene(id) {
      await query(db, "DELETE FROM scenes WHERE id = $1", [id]);
    },
    async reassignProviderObservations(ids, canonicalId) {
      await query(
        db,
        "UPDATE provider_observations SET scene_id = $1 WHERE scene_id = ANY($2::text[]) AND scene_id <> $1",
        [canonicalId, ids],
      );
    },
    async upsertProviderObservation(o) {
      if (
        !o.providerId ||
        !o.recordId ||
        !o.studioId ||
        !o.sceneId ||
        !o.studio ||
        !o.record ||
        typeof o.record !== "object"
      ) {
        throw new TypeError("Invalid provider observation at store boundary");
      }
      let { rows } = await query(
        db,
        `SELECT provider_id,studio_id,record_json FROM provider_observations
        WHERE provider_id=$1 AND studio_id=$2 AND record_id=$3`,
        [o.providerId, o.studioId, o.recordId],
      );
      if (!rows.length && o.providerId.startsWith("tpdb-site-")) {
        const legacy = await query(
          db,
          `SELECT provider_id,studio_id,record_json FROM provider_observations
          WHERE record_id=$1 AND provider_id=ANY($2::text[])`,
          [o.recordId, [o.providerId, "tpdb-watchlist"]],
        );
        if (legacy.rows.length === 1) rows = legacy.rows;
      }
      const prior = rows[0];
      const previous = prior?.record_json ?? {};
      const record = { ...previous, ...o.record };
      for (const field of [
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
      ]) {
        const value = o.record[field];
        if (
          (value == null || value === "" || (Array.isArray(value) && !value.length)) &&
          previous[field] != null
        )
          record[field] = previous[field];
      }
      record.fieldProvenance = { ...previous.fieldProvenance, ...o.record.fieldProvenance };
      const statements = [
        {
          sql: `INSERT INTO provider_observations (provider_id,record_id,studio_id,scene_id,studio,record_json,fetched_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (provider_id,studio_id,record_id) DO UPDATE SET
        scene_id=EXCLUDED.scene_id,studio=EXCLUDED.studio,record_json=EXCLUDED.record_json,fetched_at=EXCLUDED.fetched_at`,
          params: [
            o.providerId,
            o.recordId,
            o.studioId,
            o.sceneId,
            o.studio,
            json(record),
            o.fetchedAt,
          ],
        },
      ];
      if (prior && (prior.provider_id !== o.providerId || prior.studio_id !== o.studioId))
        statements.push({
          sql: "DELETE FROM provider_observations WHERE provider_id=$1 AND studio_id=$2 AND record_id=$3",
          params: [prior.provider_id, prior.studio_id, o.recordId],
        });
      await db.transaction(statements);
    },
    async listProviderObservations(sceneId) {
      const { rows } = await query(
        db,
        `SELECT * FROM provider_observations ${sceneId ? "WHERE scene_id=$1" : ""}
        ORDER BY provider_id,studio_id,record_id`,
        sceneId ? [sceneId] : [],
      );
      return rows.map((r) => ({
        providerId: r.provider_id,
        recordId: r.record_id,
        studioId: r.studio_id,
        sceneId: r.scene_id,
        studio: r.studio,
        record: r.record_json,
        fetchedAt: r.fetched_at,
      }));
    },
    async removeProviderRecords(providerId, recordIds) {
      if (!recordIds.length) return [];
      const { rows } = await query(
        db,
        "SELECT scene_id FROM provider_observations WHERE provider_id=$1 AND record_id=ANY($2::text[])",
        [providerId, recordIds],
      );
      const ids = [...new Set(rows.map((r) => r.scene_id))];
      await db.transaction([
        {
          sql: "DELETE FROM provider_observations WHERE provider_id=$1 AND record_id=ANY($2::text[])",
          params: [providerId, recordIds],
        },
        {
          sql: "DELETE FROM scenes s WHERE s.id=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM provider_observations p WHERE p.scene_id=s.id)",
          params: [ids],
        },
      ]);
      return ids;
    },
    async deleteSourceScenes(sourceId, nativeIds) {
      if (!nativeIds.length) return 0;
      const ids = [...new Set(nativeIds)].map((id) => `${sourceId}:${id}`);
      const result = await query(
        db,
        "DELETE FROM scenes WHERE source_id=$1 AND id=ANY($2::text[])",
        [sourceId, ids],
      );
      return result.rowCount;
    },
    async deleteReleasedBefore(before) {
      const { rows } = await query(db, "DELETE FROM scenes WHERE release_date < $1 RETURNING id", [
        before,
      ]);
      return rows.map((r) => r.id);
    },
    async pruneScenesForUnknownSources(sourceIds) {
      if (!sourceIds.length) return 0;
      const { rows } = await query(
        db,
        "SELECT COUNT(*)::int AS n FROM scenes WHERE source_id=ANY($1::text[])",
        [sourceIds],
      );
      await db.transaction([
        { sql: "DELETE FROM scenes WHERE source_id=ANY($1::text[])", params: [sourceIds] },
        { sql: "DELETE FROM sources WHERE source_id=ANY($1::text[])", params: [sourceIds] },
      ]);
      return rows[0].n;
    },
    async upsertSource(s) {
      await query(
        db,
        `INSERT INTO sources(source_id,label_id,name,label,authority,creator_studio,window_days,matcher,last_success_at,last_error,scene_count)
        VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11) ON CONFLICT(source_id,label_id) DO UPDATE SET
        name=EXCLUDED.name,label=EXCLUDED.label,authority=EXCLUDED.authority,creator_studio=EXCLUDED.creator_studio,
        window_days=EXCLUDED.window_days,matcher=EXCLUDED.matcher,last_success_at=EXCLUDED.last_success_at,
        last_error=EXCLUDED.last_error,scene_count=EXCLUDED.scene_count`,
        [
          s.sourceId,
          s.labelId,
          s.name ?? "",
          s.label ?? "",
          s.authority ? json(s.authority) : null,
          Boolean(s.creatorStudio),
          s.windowDays ?? 90,
          s.matcher ?? null,
          s.lastSuccessAt ?? null,
          s.lastError ?? null,
          s.sceneCount ?? 0,
        ],
      );
    },
    async listSources() {
      const { rows } = await query(db, "SELECT * FROM sources ORDER BY source_id,label_id");
      return rows.map((r) => ({
        sourceId: r.source_id,
        labelId: r.label_id,
        name: r.name,
        label: r.label,
        authority: r.authority,
        creatorStudio: r.creator_studio,
        windowDays: r.window_days,
        matcher: r.matcher,
        lastSuccessAt: r.last_success_at,
        lastError: r.last_error,
        sceneCount: r.scene_count,
      }));
    },
    async upsertPoolVideo(v) {
      await query(
        db,
        `INSERT INTO pool_videos (id,uploader,title,added,duration_sec,hydrated_at,views)
        VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id,uploader) DO UPDATE SET
        title=COALESCE(EXCLUDED.title,pool_videos.title), added=COALESCE(EXCLUDED.added,pool_videos.added),
        duration_sec=COALESCE(EXCLUDED.duration_sec,pool_videos.duration_sec), hydrated_at=COALESCE(EXCLUDED.hydrated_at,pool_videos.hydrated_at),
        views=COALESCE(EXCLUDED.views,pool_videos.views)`,
        [v.id, v.uploader, v.title, toIsoUtc(v.added), v.durationSec, v.hydratedAt, v.views],
      );
    },
    async poolVideosUndated(uploader, limit) {
      const { rows } = await query(
        db,
        `SELECT * FROM pool_videos WHERE uploader=$1 AND added IS NULL
        ORDER BY undated_scanned_at ASC NULLS FIRST, indexed_order ASC ${limit === undefined ? "" : "LIMIT $2"}`,
        limit === undefined ? [uploader] : [uploader, Math.max(0, Math.floor(limit))],
      );
      return rows.map(poolVideo);
    },
    async poolVideosInWindow(uploader, from, to, band) {
      const params = [uploader, from, to];
      const filter = band
        ? (params.push(band.durationSec, band.toleranceSec),
          " AND (duration_sec IS NULL OR ABS(duration_sec-$4)<=$5)")
        : "";
      const { rows } = await query(
        db,
        `SELECT * FROM pool_videos WHERE uploader=$1 AND added IS NOT NULL AND added >= $2 AND added <= $3${filter}
        ORDER BY added DESC, hydration_attempted_at ASC NULLS FIRST, indexed_order ASC`,
        params,
      );
      return rows.map(poolVideo);
    },
    async poolVideoExists(id, uploader) {
      const { rows } = await query(db, "SELECT 1 FROM pool_videos WHERE id=$1 AND uploader=$2", [
        id,
        uploader,
      ]);
      return rows.length > 0;
    },
    async poolVideosForUploader(uploader) {
      const { rows } = await query(
        db,
        "SELECT * FROM pool_videos WHERE uploader=$1 ORDER BY added DESC NULLS LAST",
        [uploader],
      );
      return rows.map(poolVideo);
    },
    async setPoolDuration(id, uploader, durationSec, hydratedAt) {
      await query(
        db,
        "UPDATE pool_videos SET duration_sec=$1,hydrated_at=$2 WHERE id=$3 AND uploader=$4",
        [durationSec, hydratedAt, id, uploader],
      );
    },
    async poolVideoCount() {
      const { rows } = await query(db, "SELECT COUNT(*)::int AS n FROM pool_videos");
      return rows[0].n;
    },
    async poolUndatedCount() {
      const { rows } = await query(
        db,
        "SELECT COUNT(*)::int AS n FROM pool_videos WHERE added IS NULL",
      );
      return rows[0].n;
    },
    async prunePoolUploader(uploader, before) {
      const result = await query(
        db,
        "DELETE FROM pool_videos WHERE uploader=$1 AND added IS NOT NULL AND added<$2",
        [uploader, before],
      );
      return result.rowCount;
    },
    async prunePoolMissing(uploader, seen) {
      const result = await query(
        db,
        "DELETE FROM pool_videos WHERE uploader=$1 AND NOT (id=ANY($2::text[]))",
        [uploader, [...seen]],
      );
      return result.rowCount;
    },
    async setPoolHydration(id, uploader, durationSec, added, hydratedAt, views = null) {
      await query(
        db,
        `UPDATE pool_videos SET duration_sec=$1, added=COALESCE($2,added), views=COALESCE($3,views), hydrated_at=$4
        WHERE id=$5 AND uploader=$6`,
        [durationSec, toIsoUtc(added), views, hydratedAt, id, uploader],
      );
    },
    async markPoolHydrationAttempt(id, uploader, at) {
      await query(
        db,
        "UPDATE pool_videos SET hydration_attempted_at=$1,undated_scanned_at=$1 WHERE id=$2 AND uploader=$3",
        [at, id, uploader],
      );
    },
    async markPoolUndatedScan(id, uploader, at) {
      await query(
        db,
        "UPDATE pool_videos SET undated_scanned_at=$1 WHERE id=$2 AND uploader=$3 AND added IS NULL",
        [at, id, uploader],
      );
    },
    async latestPoolProgressAt() {
      const { rows } = await query(db, "SELECT MAX(undated_scanned_at) AS at FROM pool_videos");
      return rows[0]?.at ?? null;
    },
    async poolWatermark(uploader) {
      const { rows } = await query(
        db,
        "SELECT MAX(added) AS at FROM pool_videos WHERE uploader=$1",
        [uploader],
      );
      return rows[0]?.at ?? null;
    },
    async getPoolMeta(key) {
      const { rows } = await query(db, "SELECT value FROM pool_meta WHERE key=$1", [key]);
      return rows[0]?.value ?? null;
    },
    async setPoolMeta(key, value) {
      await query(
        db,
        "INSERT INTO pool_meta(key,value) VALUES($1,$2) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [key, value],
      );
    },
    async recordRun(run) {
      await query(
        db,
        `INSERT INTO runs(id,kind,started_at,ended_at,outcomes,ok,error,resolver_health)
      VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb) ON CONFLICT(id) DO UPDATE SET ended_at=EXCLUDED.ended_at,
      outcomes=EXCLUDED.outcomes,ok=EXCLUDED.ok,error=EXCLUDED.error,resolver_health=EXCLUDED.resolver_health`,
        [
          run.id,
          run.kind,
          run.startedAt,
          run.endedAt,
          json(run.outcomes),
          run.ok,
          run.error,
          run.resolverHealth ? json(run.resolverHealth) : null,
        ],
      );
    },
    async recentRuns(limit) {
      const { rows } = await query(db, "SELECT * FROM runs ORDER BY started_at DESC LIMIT $1", [
        limit,
      ]);
      return rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        outcomes: r.outcomes,
        ok: r.ok,
        error: r.error,
        resolverHealth: r.resolver_health,
      }));
    },
    async noteFc2Sightings(records, seenAt) {
      if (!records.length) return;
      const unique = [...new Map(records.map((r) => [r.videoId, r])).values()];
      await db.transaction(
        unique.map((r) => ({
          sql: `INSERT INTO fc2_candidates(video_id,release_date,status,verdict,scene_json,first_seen_at)
        VALUES($1,$2,'pending','',NULL,$3) ON CONFLICT(video_id) DO UPDATE SET
        status=CASE WHEN fc2_candidates.release_date<>EXCLUDED.release_date THEN 'pending' ELSE fc2_candidates.status END,
        verdict=CASE WHEN fc2_candidates.release_date<>EXCLUDED.release_date THEN '' ELSE fc2_candidates.verdict END,
        scene_json=CASE WHEN fc2_candidates.release_date<>EXCLUDED.release_date THEN NULL ELSE fc2_candidates.scene_json END,
        checked_at=CASE WHEN fc2_candidates.release_date<>EXCLUDED.release_date THEN NULL ELSE fc2_candidates.checked_at END,
        recheck_at=CASE WHEN fc2_candidates.release_date<>EXCLUDED.release_date THEN NULL ELSE fc2_candidates.recheck_at END,
        retired_at=CASE WHEN fc2_candidates.release_date<>EXCLUDED.release_date THEN NULL ELSE fc2_candidates.retired_at END,
        release_date=EXCLUDED.release_date`,
          params: [r.videoId, r.releaseDate, seenAt],
        })),
      );
    },
    async decideFc2Candidate(
      videoId,
      status,
      verdict,
      { checkedAt, recheckAt = null, scene = null },
    ) {
      await query(
        db,
        `INSERT INTO fc2_candidates(video_id,release_date,status,verdict,scene_json,first_seen_at,checked_at,recheck_at)
        VALUES($1,'',$2,$3,$4::jsonb,$5,$5,$6) ON CONFLICT(video_id) DO UPDATE SET status=EXCLUDED.status,
        verdict=EXCLUDED.verdict,scene_json=COALESCE(EXCLUDED.scene_json,fc2_candidates.scene_json),checked_at=EXCLUDED.checked_at,
        recheck_at=EXCLUDED.recheck_at,retired_at=NULL`,
        [videoId, status, verdict, scene ? json(scene) : null, checkedAt, recheckAt],
      );
    },
    async fc2Candidate(videoId) {
      const { rows } = await query(db, "SELECT * FROM fc2_candidates WHERE video_id=$1", [videoId]);
      return rows[0] ? fc2(rows[0]) : null;
    },
    async fc2Candidates(ids) {
      if (!ids.length) return new Map();
      const { rows } = await query(
        db,
        "SELECT * FROM fc2_candidates WHERE video_id=ANY($1::text[])",
        [ids],
      );
      return new Map(rows.map((r) => [r.video_id, fc2(r)]));
    },
    async fc2DueCandidates(now, limit) {
      const { rows } = await query(
        db,
        `SELECT * FROM fc2_candidates WHERE status='pending' AND retired_at IS NULL
        AND (recheck_at IS NULL OR recheck_at <= $1) ORDER BY first_seen_at,video_id LIMIT $2`,
        [now.toISOString(), Math.max(0, Math.floor(limit))],
      );
      return rows.map(fc2);
    },
    async retireFc2StalePending(videoId, now) {
      const r = await query(
        db,
        `UPDATE fc2_candidates SET retired_at=$1 WHERE video_id=$2 AND status='pending'
        AND retired_at IS NULL AND recheck_at IS NOT NULL AND recheck_at<=checked_at AND checked_at=$1`,
        [now.toISOString(), videoId],
      );
      return r.rowCount;
    },
    async deleteFc2CandidatesBefore(before) {
      const r = await query(db, "DELETE FROM fc2_candidates WHERE release_date<$1", [before]);
      return r.rowCount;
    },
    async countFc2Pending() {
      const { rows } = await query(
        db,
        "SELECT COUNT(*)::int AS n FROM fc2_candidates WHERE status='pending' AND retired_at IS NULL",
      );
      return rows[0].n;
    },
    async fc2CandidateCounts() {
      const { rows } = await query(
        db,
        "SELECT status,COUNT(*)::int AS n FROM fc2_candidates GROUP BY status",
      );
      const counts = { accepted: 0, excluded: 0, pending: 0 };
      for (const r of rows) counts[r.status] = r.n;
      return counts;
    },
  };

  async function hydrate(rows) {
    if (!rows.length) return [];
    const { rows: links } = await query(
      db,
      "SELECT * FROM scene_links WHERE scene_id = ANY($1::text[])",
      [rows.map((r) => r.id)],
    );
    const grouped = new Map();
    for (const link of links)
      grouped.set(link.scene_id, [...(grouped.get(link.scene_id) ?? []), link]);
    return rows.map((row) => sceneFromRows(row, grouped.get(row.id) ?? []));
  }
  function poolVideo(row) {
    return {
      id: row.id,
      uploader: row.uploader,
      title: row.title,
      added: row.added,
      durationSec: row.duration_sec,
      hydratedAt: row.hydrated_at,
      hydrationAttemptedAt: row.hydration_attempted_at,
      views: row.views,
    };
  }
  function fc2(row) {
    return {
      videoId: row.video_id,
      releaseDate: row.release_date,
      status: row.status,
      verdict: row.verdict,
      scene: row.scene_json,
      firstSeenAt: row.first_seen_at,
      checkedAt: row.checked_at,
      recheckAt: row.recheck_at,
      retiredAt: row.retired_at,
    };
  }
  return store;
}
