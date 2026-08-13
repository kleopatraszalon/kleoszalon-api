BEGIN;

INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,'system_settings',true)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  icon=EXCLUDED.icon,
  route=NULL,
  order_index=EXCLUDED.order_index,
  parent_id=NULL,
  feature_key=EXCLUDED.feature_key,
  is_active=true;

WITH p AS (SELECT id FROM menus WHERE code='settings' LIMIT 1)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'settings.general','Rendszerbeállítások','SlidersHorizontal','/settings',10,p.id,'system_settings',true
FROM p
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  icon=EXCLUDED.icon,
  route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,
  feature_key=EXCLUDED.feature_key,
  is_active=true;

-- Admin: teljes konfigurációs jog. Manager: megtekintés, audit és riasztások.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'admin',m.id,true,true,true,false,false,true,true,true,'all_locations',now()
FROM menus m WHERE m.code IN ('settings','settings.general')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=false,can_approve=false,
  can_export=true,can_view_financial=true,can_manage_permissions=true,
  scope_type='all_locations',updated_at=now();

INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'manager',m.id,true,false,false,false,false,true,true,false,'all_locations',now()
FROM menus m WHERE m.code IN ('settings','settings.general')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=true,can_view_financial=true,can_manage_permissions=false,
  scope_type='all_locations',updated_at=now();

COMMIT;
