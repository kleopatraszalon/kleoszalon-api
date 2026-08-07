BEGIN;

CREATE TABLE IF NOT EXISTS dashboard_settings (
  id integer PRIMARY KEY,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO dashboard_settings (id, settings)
VALUES (
  1,
  '{
    "executive_overview": true,
    "period_insights": true,
    "targets": true,
    "live_business": true,
    "classic_kpis": true,
    "revenue_mix": true,
    "location_performance": true,
    "hr_performance": true,
    "top_staff_alerts": true
  }'::jsonb
)
ON CONFLICT (id) DO NOTHING;

COMMIT;
