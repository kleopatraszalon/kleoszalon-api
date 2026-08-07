BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS uat_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES uat_test_runs(id) ON DELETE CASCADE,
  result_id uuid REFERENCES uat_test_results(id) ON DELETE SET NULL,
  test_case_id uuid REFERENCES uat_test_cases(id) ON DELETE SET NULL,
  code text NOT NULL UNIQUE,
  title text NOT NULL,
  description text,
  priority text NOT NULL DEFAULT 'medium',
  status text NOT NULL DEFAULT 'open',
  assignee text,
  reporter text,
  resolution text,
  retest_required boolean NOT NULL DEFAULT true,
  retest_status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  closed_at timestamptz,
  CONSTRAINT uat_issues_priority_ck CHECK(priority IN ('critical','high','medium','low')),
  CONSTRAINT uat_issues_status_ck CHECK(status IN ('open','in_progress','fixed','retest','closed','rejected')),
  CONSTRAINT uat_issues_retest_ck CHECK(retest_status IN ('pending','passed','failed','not_required'))
);

CREATE INDEX IF NOT EXISTS uat_issues_run_idx ON uat_issues(run_id,status,priority,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uat_issues_open_result_uq
  ON uat_issues(result_id)
  WHERE result_id IS NOT NULL AND status NOT IN ('closed','rejected');

COMMIT;
