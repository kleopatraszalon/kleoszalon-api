BEGIN;

-- ============================================================
-- KLEOSZALON – JOGOSULTSÁGKEZELÉS V2
-- Funkció + menü/művelet + hatókör. PgAdminból futtatandó.
-- ============================================================

CREATE TABLE IF NOT EXISTS role_feature_permissions (
  role_key text NOT NULL,
  feature_key text NOT NULL,
  can_use boolean NOT NULL DEFAULT false,
  scope_type text NOT NULL DEFAULT 'own_location',
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(role_key,feature_key)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='role_feature_permissions_scope_check') THEN
    ALTER TABLE role_feature_permissions ADD CONSTRAINT role_feature_permissions_scope_check
      CHECK(scope_type IN ('own','own_location','selected_locations','all_locations'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='role_menu_permissions_scope_check') THEN
    ALTER TABLE role_menu_permissions ADD CONSTRAINT role_menu_permissions_scope_check
      CHECK(scope_type IN ('own','own_location','selected_locations','all_locations'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS role_feature_permissions_feature_idx
  ON role_feature_permissions(feature_key,role_key);

-- Funkciószintű alapértelmezések.
-- Admin a middleware-ben mindig teljes hozzáférést kap, de az adatbázisban is
-- szerepeltetjük az átlátható admin mátrix miatt.
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
SELECT 'admin',x.feature_key,true,'all_locations',now()
FROM (VALUES
 ('finance'),('hr'),('ai_use'),('ai_stats'),('staff_chat'),('staff_chat_all'),
 ('inventory'),('procurement'),('management_dashboard'),('audit')
) x(feature_key)
ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=true,scope_type='all_locations',updated_at=now();

INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
SELECT 'manager',x.feature_key,true,'all_locations',now()
FROM (VALUES
 ('finance'),('hr'),('ai_use'),('ai_stats'),('staff_chat'),('staff_chat_all'),
 ('inventory'),('procurement'),('management_dashboard'),('audit')
) x(feature_key)
ON CONFLICT(role_key,feature_key) DO NOTHING;

INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
VALUES
 ('receptionist','finance',true,'own_location'),
 ('receptionist','hr',false,'own_location'),
 ('receptionist','ai_use',true,'own_location'),
 ('receptionist','ai_stats',false,'own_location'),
 ('receptionist','staff_chat',true,'own_location'),
 ('receptionist','staff_chat_all',false,'own_location'),
 ('receptionist','inventory',true,'own_location'),
 ('receptionist','procurement',true,'own_location'),
 ('receptionist','management_dashboard',false,'own_location'),
 ('receptionist','audit',false,'own_location'),
 ('employee','finance',false,'own'),
 ('employee','hr',false,'own'),
 ('employee','ai_use',true,'own'),
 ('employee','ai_stats',false,'own'),
 ('employee','staff_chat',true,'own'),
 ('employee','staff_chat_all',false,'own'),
 ('employee','inventory',false,'own'),
 ('employee','procurement',false,'own'),
 ('employee','management_dashboard',false,'own'),
 ('employee','audit',false,'own')
ON CONFLICT(role_key,feature_key) DO NOTHING;

-- Az admin minden jelenlegi és később a migráció előtt már létrehozott menüre teljes jogot kap.
INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus m WHERE COALESCE(m.is_active,true)=true
ON CONFLICT(role_key,menu_id) DO UPDATE SET
 can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,
 can_view_financial=true,can_manage_permissions=true,scope_type='all_locations',updated_at=now();

-- Vezető: teljes beszerzési munkafolyamat, törlés nélkül.
INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'manager',m.id,true,true,true,false,true,true,true,false,'all_locations',now()
FROM menus m
WHERE m.code='procurement' OR m.code LIKE 'procurement.%'
ON CONFLICT(role_key,menu_id) DO UPDATE SET
 can_view=true,can_create=true,can_edit=true,can_delete=false,can_approve=true,can_export=true,
 can_view_financial=true,scope_type='all_locations',updated_at=now();

-- Recepció: javaslatok/beszállítók/rendelések kezelhetők a saját telephelyen,
-- vezetői jóváhagyás és pénzügyi jogosultság nélkül.
INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'receptionist',m.id,
 true,
 CASE WHEN m.code IN ('procurement.suggestions','procurement.orders','procurement.suppliers') THEN true ELSE false END,
 CASE WHEN m.code IN ('procurement.orders','procurement.suppliers','procurement.prices') THEN true ELSE false END,
 false,false,
 CASE WHEN m.code='procurement.orders' THEN true ELSE false END,
 false,false,'own_location',now()
FROM menus m
WHERE m.code='procurement' OR m.code LIKE 'procurement.%'
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- Employee számára a Beszerzés explicit tiltott, így nem csak a menüből tűnik el,
-- hanem a feature middleware is megtagadja.
INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'employee',m.id,false,false,false,false,false,false,false,false,'own',now()
FROM menus m
WHERE m.code='procurement' OR m.code LIKE 'procurement.%'
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- Jogosultságkezelés csak admin számára.
INSERT INTO role_menu_permissions
 (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus m WHERE m.code='settings.access'
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_manage_permissions=true,updated_at=now();

COMMIT;
