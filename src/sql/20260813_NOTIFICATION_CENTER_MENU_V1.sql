BEGIN;

DO $$
DECLARE parent_id bigint;
BEGIN
  SELECT id INTO parent_id FROM menus WHERE code='settings' LIMIT 1;
  IF parent_id IS NOT NULL THEN
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES('settings.notification-center','Értesítési központ','BellRing','/dashboard/notifications',35,parent_id,'management_dashboard',true)
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;
  END IF;
END $$;

INSERT INTO schema_migrations(version,description)
VALUES('20260813_NOTIFICATION_CENTER_MENU_V1','Értesítési központ menü a meglévő VIR figyelmeztetésekhez')
ON CONFLICT(version) DO NOTHING;

COMMIT;
