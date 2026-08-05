BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS access_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL,
  name text NOT NULL,
  description text,
  level integer NOT NULL DEFAULT 10,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS access_roles_key_uq ON access_roles(lower(role_key));
INSERT INTO access_roles(role_key,name,description,level,is_system) VALUES
 ('admin','Rendszergazda','Teljes rendszerhozzáférés',100,true),
 ('manager','Vezető','Vezetői és jóváhagyási feladatok',80,true),
 ('receptionist','Recepciós','Foglalás, ügyfélkezelés és pénztár',50,true),
 ('employee','Munkatárs','Saját napi munkavégzéshez szükséges hozzáférés',20,true)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS role_menu_permissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_key text NOT NULL,
  menu_id bigint NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT false,
  can_create boolean NOT NULL DEFAULT false,
  can_edit boolean NOT NULL DEFAULT false,
  can_delete boolean NOT NULL DEFAULT false,
  can_approve boolean NOT NULL DEFAULT false,
  can_export boolean NOT NULL DEFAULT false,
  can_view_financial boolean NOT NULL DEFAULT false,
  can_manage_permissions boolean NOT NULL DEFAULT false,
  scope_type text NOT NULL DEFAULT 'own_location',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(role_key,menu_id)
);
CREATE INDEX IF NOT EXISTS role_menu_permissions_lookup_idx ON role_menu_permissions(lower(role_key),menu_id,can_view);

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations' FROM menus m
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,can_view_financial=true,can_manage_permissions=true,scope_type='all_locations';

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,scope_type)
SELECT 'manager',m.id,true,true,true,false,true,true,true,'all_locations' FROM menus m
ON CONFLICT(role_key,menu_id) DO NOTHING;

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,scope_type)
SELECT 'receptionist',m.id,true,true,true,'own_location' FROM menus m
WHERE COALESCE(m.code,'') ~ '^(dashboard|appointments|customers|loyalty|finance.checkout|finance.workorders|team.schedule|team.vacations)'
ON CONFLICT(role_key,menu_id) DO NOTHING;

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_edit,scope_type)
SELECT 'employee',m.id,true,true,'own' FROM menus m
WHERE COALESCE(m.code,'') IN ('dashboard','appointments','appointments.calendar','team','team.schedule','team.vacations')
ON CONFLICT(role_key,menu_id) DO NOTHING;

INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'settings.access','Jogosultságok és menü-hozzáférés','ShieldCheck','/admin/access-control',45,p.id,'access_control',true
FROM menus p WHERE p.code='settings' AND NOT EXISTS(SELECT 1 FROM menus x WHERE x.code='settings.access');
UPDATE menus SET name='Jogosultságok és menü-hozzáférés',route='/admin/access-control',feature_key='access_control',is_active=true WHERE code='settings.access';

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations' FROM menus m WHERE m.code='settings.access'
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_manage_permissions=true;

INSERT INTO schema_migrations(version,description) VALUES('20260804_ACCESS_CONTROL_V1','Szerepkör- és menüalapú jogosultsági mátrix') ON CONFLICT(version) DO NOTHING;
COMMIT;
