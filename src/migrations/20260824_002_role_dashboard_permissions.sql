-- Minden belső munkakör megkapja a saját, szerepkörre szabott indítópult elérését.
-- Ez kizárólag az indítópult olvasását engedi; pénzügyi, adminisztrációs vagy
-- vezetői riport jogosultságot nem emel meg.
WITH role_scopes(role_key,scope_type) AS (VALUES
  ('manager','all_locations'),
  ('hr_manager','all_locations'),
  ('accounting','all_locations'),
  ('location_manager','own_location'),
  ('salon_manager','own_location'),
  ('receptionist','own_location'),
  ('reception','own_location'),
  ('recepciós','own_location'),
  ('recepcios','own_location'),
  ('employee','own'),
  ('cosmetician','own'),
  ('kozmetikus','own')
)
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
SELECT role_key,'management_dashboard',true,scope_type,now()
FROM role_scopes
ON CONFLICT(role_key,feature_key) DO UPDATE SET
  can_use=true,
  scope_type=EXCLUDED.scope_type,
  updated_at=now();

WITH role_scopes(role_key,scope_type) AS (VALUES
  ('manager','all_locations'),
  ('hr_manager','all_locations'),
  ('accounting','all_locations'),
  ('location_manager','own_location'),
  ('salon_manager','own_location'),
  ('receptionist','own_location'),
  ('reception','own_location'),
  ('recepciós','own_location'),
  ('recepcios','own_location'),
  ('employee','own'),
  ('cosmetician','own'),
  ('kozmetikus','own')
)
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT r.role_key,m.id,true,false,false,false,false,false,false,false,r.scope_type,now()
FROM role_scopes r
CROSS JOIN menus m
WHERE m.code='dashboard' AND COALESCE(m.is_active,true)=true
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,
  scope_type=EXCLUDED.scope_type,
  updated_at=now();
