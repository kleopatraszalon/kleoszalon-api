BEGIN;

CREATE TABLE IF NOT EXISTS role_location_permissions (
  role_key text NOT NULL,
  location_id bigint NOT NULL,
  can_access boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(role_key, location_id)
);
CREATE INDEX IF NOT EXISTS role_location_permissions_location_idx ON role_location_permissions(location_id, role_key);

-- A fő üzleti feature-ök minden ismert szerepkörhöz kapjanak explicit sort.
WITH roles AS (
  SELECT lower(role_key) role_key FROM access_roles WHERE COALESCE(is_active,true)
), features(feature_key) AS (VALUES
 ('finance'),('hr'),('ai_use'),('ai_stats'),('staff_chat'),('staff_chat_all'),
 ('inventory'),('procurement'),('management_dashboard'),('audit')
)
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
SELECT r.role_key,f.feature_key,
 CASE
  WHEN r.role_key='admin' THEN true
  WHEN r.role_key='manager' THEN true
  WHEN r.role_key='receptionist' AND f.feature_key IN ('finance','ai_use','staff_chat','inventory','procurement') THEN true
  WHEN r.role_key='employee' AND f.feature_key IN ('ai_use','staff_chat') THEN true
  ELSE false END,
 CASE WHEN r.role_key IN ('admin','manager') THEN 'all_locations'
      WHEN r.role_key='employee' THEN 'own'
      ELSE 'own_location' END,
 now()
FROM roles r CROSS JOIN features f
ON CONFLICT(role_key,feature_key) DO NOTHING;

-- Admin teljes hozzáférés minden aktív menühöz.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'admin',id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus WHERE COALESCE(is_active,true)
ON CONFLICT(role_key,menu_id) DO UPDATE SET
 can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,
 can_export=true,can_view_financial=true,can_manage_permissions=true,
 scope_type='all_locations',updated_at=now();

-- Manager: minden aktív menü megtekinthető és szerkeszthető; törlés és jogosultságkezelés külön admin művelet.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'manager',id,true,true,true,false,true,true,true,false,'all_locations',now()
FROM menus WHERE COALESCE(is_active,true)
ON CONFLICT(role_key,menu_id) DO NOTHING;

COMMIT;

-- Ellenőrzés:
-- SELECT role_key,feature_key,can_use,scope_type FROM role_feature_permissions ORDER BY role_key,feature_key;
-- SELECT p.role_key,m.code,p.can_view,p.can_create,p.can_edit,p.can_delete,p.can_approve,p.can_export,p.can_view_financial,p.scope_type
-- FROM role_menu_permissions p JOIN menus m ON m.id=p.menu_id ORDER BY p.role_key,m.order_index,m.id;
