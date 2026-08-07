BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS finance_period_closings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  period_month text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  closed_by text,
  closed_at timestamptz,
  reopened_by text,
  reopened_at timestamptz,
  note text,
  control_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT finance_period_closings_month_ck CHECK(period_month ~ '^\d{4}-\d{2}$'),
  CONSTRAINT finance_period_closings_status_ck CHECK(status IN ('open','closed','reopened'))
);

CREATE UNIQUE INDEX IF NOT EXISTS finance_period_closings_location_month_uq
ON finance_period_closings(COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid),period_month);

CREATE INDEX IF NOT EXISTS finance_period_closings_month_idx
ON finance_period_closings(period_month,status);

COMMIT;
