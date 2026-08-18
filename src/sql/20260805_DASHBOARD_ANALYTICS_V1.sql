BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  description text,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS management_daily_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fact_date date NOT NULL,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  position_id uuid REFERENCES hr_positions(id) ON DELETE SET NULL,
  service_revenue numeric(14,2) NOT NULL DEFAULT 0,
  product_revenue numeric(14,2) NOT NULL DEFAULT 0,
  invoice_count integer NOT NULL DEFAULT 0,
  appointment_count integer NOT NULL DEFAULT 0,
  completed_count integer NOT NULL DEFAULT 0,
  cancelled_count integer NOT NULL DEFAULT 0,
  no_show_count integer NOT NULL DEFAULT 0,
  new_client_count integer NOT NULL DEFAULT 0,
  available_minutes integer NOT NULL DEFAULT 480,
  productive_minutes integer NOT NULL DEFAULT 0,
  sick_minutes integer NOT NULL DEFAULT 0,
  paid_leave_minutes integer NOT NULL DEFAULT 0,
  unpaid_leave_minutes integer NOT NULL DEFAULT 0,
  unexcused_minutes integer NOT NULL DEFAULT 0,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(fact_date, employee_id)
);

CREATE INDEX IF NOT EXISTS management_daily_facts_date_location_idx
  ON management_daily_facts(fact_date, location_id);
CREATE INDEX IF NOT EXISTS management_daily_facts_position_idx
  ON management_daily_facts(position_id, fact_date);

WITH source AS (
  SELECT
    d::date fact_date,
    e.id::text::uuid employee_id,
    e.location_id::text::uuid location_id,
    CASE
      WHEN e.position_id IS NOT NULL
       AND e.position_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      THEN e.position_id::text::uuid
      ELSE NULL::uuid
    END position_id,
    mod(abs(hashtext(e.id::text || d::date::text))::bigint, 1000)::int seed,
    mod(abs(hashtext('a' || e.id::text || d::date::text))::bigint, 5)::int extra_appointments,
    mod(abs(hashtext('r' || e.id::text || d::date::text))::bigint, 42000)::int revenue_extra
  FROM employees e
  CROSS JOIN generate_series(CURRENT_DATE - INTERVAL '89 days', CURRENT_DATE, INTERVAL '1 day') d
  WHERE e.email LIKE 'demo.%@kleoszalon.hu'
    AND e.id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND e.location_id IS NOT NULL
    AND e.location_id::text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND EXTRACT(ISODOW FROM d) BETWEEN 1 AND 6
)
INSERT INTO management_daily_facts(
  fact_date,location_id,employee_id,position_id,service_revenue,product_revenue,
  invoice_count,appointment_count,completed_count,cancelled_count,no_show_count,
  new_client_count,available_minutes,productive_minutes,sick_minutes,
  paid_leave_minutes,unpaid_leave_minutes,unexcused_minutes,is_demo
)
SELECT
  fact_date,location_id,employee_id,position_id,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 THEN 0 ELSE 26000 + revenue_extra END,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 THEN 0 ELSE 2500 + (seed % 14500) END,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 THEN 0 ELSE 3 + extra_appointments END,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 THEN 0 ELSE 4 + extra_appointments END,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 THEN 0 ELSE 3 + extra_appointments END,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 THEN 0 ELSE CASE WHEN seed % 9 = 0 THEN 1 ELSE 0 END END,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 THEN 0 ELSE CASE WHEN seed % 17 = 0 THEN 1 ELSE 0 END END,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 THEN 0 ELSE seed % 3 END,
  480,
  CASE WHEN seed % 53 = 0 OR seed % 71 = 0 OR seed % 97 = 0 THEN 0 ELSE 250 + seed % 211 END,
  CASE WHEN seed % 53 = 0 THEN 480 ELSE 0 END,
  CASE WHEN seed % 71 = 0 THEN 480 ELSE 0 END,
  0,
  CASE WHEN seed % 97 = 0 THEN 480 ELSE 0 END,
  true
FROM source
ON CONFLICT(fact_date,employee_id) DO UPDATE SET
  location_id=EXCLUDED.location_id,
  position_id=EXCLUDED.position_id,
  service_revenue=EXCLUDED.service_revenue,
  product_revenue=EXCLUDED.product_revenue,
  invoice_count=EXCLUDED.invoice_count,
  appointment_count=EXCLUDED.appointment_count,
  completed_count=EXCLUDED.completed_count,
  cancelled_count=EXCLUDED.cancelled_count,
  no_show_count=EXCLUDED.no_show_count,
  new_client_count=EXCLUDED.new_client_count,
  available_minutes=EXCLUDED.available_minutes,
  productive_minutes=EXCLUDED.productive_minutes,
  sick_minutes=EXCLUDED.sick_minutes,
  paid_leave_minutes=EXCLUDED.paid_leave_minutes,
  unpaid_leave_minutes=EXCLUDED.unpaid_leave_minutes,
  unexcused_minutes=EXCLUDED.unexcused_minutes,
  updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES ('20260805_DASHBOARD_ANALYTICS_V1','90 napos vezetői demó ténytár: árbevétel, kapacitás és távollét')
ON CONFLICT(version) DO NOTHING;

COMMIT;