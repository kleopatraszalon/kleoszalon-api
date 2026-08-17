CREATE TABLE IF NOT EXISTS saas_lifecycle_scheduler_runs (
  id BIGSERIAL PRIMARY KEY,
  trigger_source TEXT NOT NULL DEFAULT 'scheduled' CHECK (trigger_source IN ('scheduled','manual')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','skipped','failed')),
  reason TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  prepared_count INTEGER NOT NULL DEFAULT 0,
  suspended_count INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  instance_id TEXT,
  error_text TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_saas_lifecycle_scheduler_runs_started
  ON saas_lifecycle_scheduler_runs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_saas_lifecycle_scheduler_runs_status
  ON saas_lifecycle_scheduler_runs(status,started_at DESC);
CREATE INDEX IF NOT EXISTS idx_saas_lifecycle_notification_queue_status_attempt
  ON saas_lifecycle_notification_queue(status,next_attempt_at,created_at);
