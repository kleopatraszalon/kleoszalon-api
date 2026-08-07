BEGIN;

ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code) WHERE code IS NOT NULL;

DO $$
DECLARE
  v_parent_id bigint;
  v_item_id bigint;
BEGIN
  SELECT id INTO v_parent_id
  FROM menus
  WHERE code IN ('settings','settings.admin','administration')
     OR lower(name) IN ('beállítások és adminisztráció','beállítások','adminisztráció')
  ORDER BY CASE WHEN code='settings' THEN 0 ELSE 1 END, id
  LIMIT 1;

  IF v_parent_id IS NULL THEN
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,'audit',true)
    ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,is_active=true
    RETURNING id INTO v_parent_id;
  END IF;

  INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
  VALUES('settings.system_health','Rendszerellenőrzés','Activity','/admin/system-health',190,v_parent_id,'audit',true)
  ON CONFLICT(code) DO UPDATE SET
    name=EXCLUDED.name,
    icon=EXCLUDED.icon,
    route=EXCLUDED.route,
    order_index=EXCLUDED.order_index,
    parent_id=EXCLUDED.parent_id,
    feature_key=EXCLUDED.feature_key,
    is_active=true
  RETURNING id INTO v_item_id;

  INSERT INTO role_menu_permissions(
    role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
    can_view_financial,can_manage_permissions,scope_type,updated_at
  ) VALUES
    ('admin',v_item_id,true,false,false,false,false,true,true,true,'all_locations',now()),
    ('manager',v_item_id,true,false,false,false,false,true,true,false,'all_locations',now()),
    ('receptionist',v_item_id,false,false,false,false,false,false,false,false,'own_location',now()),
    ('employee',v_item_id,false,false,false,false,false,false,false,false,'own',now())
  ON CONFLICT(role_key,menu_id) DO UPDATE SET
    can_view=EXCLUDED.can_view,
    can_export=EXCLUDED.can_export,
    can_view_financial=EXCLUDED.can_view_financial,
    can_manage_permissions=EXCLUDED.can_manage_permissions,
    scope_type=EXCLUDED.scope_type,
    updated_at=now();
END $$;

COMMIT;

SELECT m.code,m.name,m.route,m.parent_id,m.order_index,m.is_active
FROM menus m
WHERE m.code='settings.system_health';
