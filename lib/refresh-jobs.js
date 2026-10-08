export async function queueRefresh(db, scheduler, reason) {
  const runId = `sync-${crypto.randomUUID()}`;
  const result = await db.query(
    `INSERT INTO refresh_jobs (id, run_id, status, reason, started_at)
     VALUES (1, $1, 'queued', $2, now())
     ON CONFLICT (id) DO UPDATE SET run_id = EXCLUDED.run_id, status = 'queued',
       reason = EXCLUDED.reason, summary = NULL, started_at = now(), updated_at = now()
     WHERE refresh_jobs.status IN ('complete', 'failed')
        OR refresh_jobs.updated_at < now() - interval '10 minutes'
     RETURNING run_id, status, reason, started_at, updated_at, summary`,
    [runId, reason],
  );
  if (!result.rows[0]) {
    const current = await db.query(
      "SELECT run_id, status, reason, started_at, updated_at, summary FROM refresh_jobs WHERE id = 1",
    );
    return { queued: false, job: current.rows[0] ?? null };
  }

  try {
    await scheduler.at(new Date(), "/api/worker", {
      payload: { runId },
      name: `liszt-refresh-${runId}`,
    });
  } catch {
    await db.query(
      "UPDATE refresh_jobs SET status = 'failed', summary = 'Unable to schedule refresh', updated_at = now() WHERE id = 1 AND run_id = $1 AND status = 'queued'",
      [runId],
    );
    throw new Error("Unable to schedule refresh");
  }
  return { queued: true, job: result.rows[0] };
}

export async function claimRefresh(db, runId) {
  const { rows } = await db.query(
    "UPDATE refresh_jobs SET status = 'running', updated_at = now() WHERE id = 1 AND run_id = $1 AND status = 'queued' RETURNING run_id",
    [runId],
  );
  return rows.length === 1;
}

export async function finishRefresh(db, runId, status, summary = null) {
  if (!new Set(["complete", "failed"]).has(status)) throw new TypeError("Invalid refresh status");
  await db.query(
    "UPDATE refresh_jobs SET status = $1, summary = $2, updated_at = now() WHERE id = 1 AND run_id = $3",
    [status, summary, runId],
  );
}

export async function currentRefresh(db) {
  const { rows } = await db.query(
    'SELECT run_id AS "runId", status, reason, started_at AS "startedAt", updated_at AS "updatedAt", summary FROM refresh_jobs WHERE id = 1',
  );
  return rows[0] ?? null;
}
