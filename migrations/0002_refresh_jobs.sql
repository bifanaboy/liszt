CREATE TABLE refresh_jobs (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  run_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'complete', 'failed')),
  reason TEXT NOT NULL,
  summary TEXT,
  started_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
