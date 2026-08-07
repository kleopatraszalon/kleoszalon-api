BEGIN;

CREATE TABLE IF NOT EXISTS dashboard_layout_profiles (
  role_key text NOT NULL DEFAULT '*',
  location_key text NOT NULL DEFAULT '*',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  widget_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (role_key, location_key)
);

CREATE INDEX IF NOT EXISTS dashboard_layout_profiles_location_idx
  ON dashboard_layout_profiles(location_key, role_key);

-- Globális alapértelmezett profil. A régi dashboard_settings tartalmát átveszi, ha a tábla létezik.
DO $$
DECLARE
  legacy_settings jsonb := '{}'::jsonb;
BEGIN
  IF to_regclass('public.dashboard_settings') IS NOT NULL THEN
    SELECT COALESCE(settings,'{}'::jsonb) INTO legacy_settings
    FROM dashboard_settings WHERE id=1;
    legacy_settings := COALESCE(legacy_settings,'{}'::jsonb);
  END IF;

  INSERT INTO dashboard_layout_profiles(role_key,location_key,settings,widget_order,updated_by,updated_at)
  VALUES(
    '*','*',legacy_settings,
    '["executive_overview","period_insights","targets","live_business","classic_kpis","revenue_mix","location_performance","hr_performance","top_staff_alerts"]'::jsonb,
    'migration',now()
  )
  ON CONFLICT(role_key,location_key) DO NOTHING;
END $$;

-- Alap szerepkörprofilok. Ezek később a Dashboard Admin felületen módosíthatók.
INSERT INTO dashboard_layout_profiles(role_key,location_key,settings,widget_order,updated_by,updated_at)
VALUES
('admin','*',
 '{"executive_overview":true,"period_insights":true,"targets":true,"live_business":true,"classic_kpis":true,"revenue_mix":true,"location_performance":true,"hr_performance":true,"top_staff_alerts":true}'::jsonb,
 '["executive_overview","live_business","classic_kpis","period_insights","targets","revenue_mix","location_performance","hr_performance","top_staff_alerts"]'::jsonb,
 'migration',now()),
('manager','*',
 '{"executive_overview":true,"period_insights":true,"targets":true,"live_business":true,"classic_kpis":true,"revenue_mix":true,"location_performance":true,"hr_performance":true,"top_staff_alerts":true}'::jsonb,
 '["executive_overview","live_business","classic_kpis","targets","period_insights","revenue_mix","location_performance","hr_performance","top_staff_alerts"]'::jsonb,
 'migration',now()),
('receptionist','*',
 '{"executive_overview":false,"period_insights":false,"targets":false,"live_business":true,"classic_kpis":true,"revenue_mix":false,"location_performance":false,"hr_performance":false,"top_staff_alerts":false}'::jsonb,
 '["live_business","classic_kpis","executive_overview","period_insights","targets","revenue_mix","location_performance","hr_performance","top_staff_alerts"]'::jsonb,
 'migration',now()),
('employee','*',
 '{"executive_overview":false,"period_insights":false,"targets":false,"live_business":false,"classic_kpis":false,"revenue_mix":false,"location_performance":false,"hr_performance":false,"top_staff_alerts":false}'::jsonb,
 '["executive_overview","period_insights","targets","live_business","classic_kpis","revenue_mix","location_performance","hr_performance","top_staff_alerts"]'::jsonb,
 'migration',now())
ON CONFLICT(role_key,location_key) DO NOTHING;

COMMIT;

-- Ellenőrzés:
-- SELECT role_key,location_key,settings,widget_order,updated_by,updated_at
-- FROM dashboard_layout_profiles ORDER BY role_key,location_key;
