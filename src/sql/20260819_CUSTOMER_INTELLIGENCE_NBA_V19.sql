-- VIR Customer Intelligence / Next Best Action v19
-- Explainable recommendation engine audit/event storage.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS crm_next_best_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id bigint NOT NULL,
  client_id text NOT NULL,
  action_code text NOT NULL,
  action_status text NOT NULL CHECK (action_status IN ('accepted','dismissed','completed')),
  channel text,
  recommendation_version text NOT NULL DEFAULT 'nba-v1',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_nba_events_tenant_client_idx
  ON crm_next_best_action_events(tenant_id, client_id, created_at DESC);

COMMENT ON TABLE crm_next_best_action_events IS
  'VIR v19 Customer Intelligence / Next Best Action audit trail. Recommendations are explainable and do not send marketing automatically.';
