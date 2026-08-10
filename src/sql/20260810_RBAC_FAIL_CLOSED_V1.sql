BEGIN;

-- ============================================================
-- KLEOSZALON – RBAC FAIL-CLOSED V1
-- A migráció markerét csak a tranzakció végén írjuk be.
-- Ettől kezdve hiányzó permission = tiltás a backend middleware-ekben.
-- ============================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  description text,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Kanonikus éles szerepkörök.
INSERT INTO access_roles(role_key,name,description,level,is_system,is_active)
SELECT x.role_key,x.name,x.description,x.level,true,true
FROM (VALUES
  ('admin','Rendszergazda','Teljes rendszerhozzáférés',100),
  ('manager','Központi vezető','Több telephelyes vezetői és jóváhagyási feladatok',80),
  ('location_manager','Üzletvezető','Saját telephely teljes napi operatív irányítása',70),
  ('salon_manager','Szalonvezető','Saját telephely operatív adatai, alapvetően olvasási jogosultsággal',60),
  ('receptionist','Recepciós','Saját telephely foglalás, ügyfélkezelés, munkalap és pénztár',50),
  ('employee','Munkatárs','Saját munkavégzéshez szükséges hozzáférés',20),
  ('customer','Ügyfél','Saját foglalások, munkalapok és ügyfélfiók',10)
) x(role_key,name,description,level)
WHERE NOT EXISTS(SELECT 1 FROM access_roles ar WHERE lower(ar.role_key)=x.role_key);

-- Minden jelenlegi aktív menühöz legyen explicit permission sor minden kanonikus szerepkörre.
-- Admin: teljes hozzáférés.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus m WHERE COALESCE(m.is_active,true)
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,
  can_export=true,can_view_financial=true,can_manage_permissions=true,
  scope_type='all_locations',updated_at=now();

-- Nem-admin szerepkörök: először explicit DENY minden aktív menüre.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT r.role_key,m.id,false,false,false,false,false,false,false,false,r.scope_type,now()
FROM (VALUES
  ('manager','all_locations'),
  ('location_manager','own_location'),
  ('salon_manager','own_location'),
  ('receptionist','own_location'),
  ('employee','own'),
  ('customer','own')
) r(role_key,scope_type)
CROSS JOIN menus m
WHERE COALESCE(m.is_active,true)
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,
  scope_type=EXCLUDED.scope_type,updated_at=now();

-- Központi vezető: minden üzleti menü kezelhető, de jogosultság-adminisztráció nem.
UPDATE role_menu_permissions p SET
  can_view=true,can_create=true,can_edit=true,can_delete=false,can_approve=true,
  can_export=true,can_view_financial=true,can_manage_permissions=false,
  scope_type='all_locations',updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='manager' AND COALESCE(m.is_active,true)
  AND COALESCE(m.code,'') NOT IN ('settings.access');

-- Érzékeny adminisztráció manager számára is csak olvasás/operáció a már engedett backend szerint.
UPDATE role_menu_permissions p SET
  can_create=false,can_edit=false,can_delete=false,can_approve=false,can_manage_permissions=false,updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='manager'
  AND COALESCE(m.code,'') IN ('settings.audit','settings.chat-supervision','settings.system_health');

-- ÜZLETVEZETŐ – saját telephely napi működése.
UPDATE role_menu_permissions p SET
  can_view=true,
  can_create=CASE WHEN
    m.code IN ('appointments','appointments.calendar','appointments.workorders','customers','customers.clients','customers.crm',
               'team.employees','team.schedule','team.attendance','finance.checkout','finance.transactions','finance.workorders',
               'inventory.stock','inventory.transfers','inventory.usage','procurement.suggestions','procurement.orders','procurement.suppliers')
    OR m.route='/workorders/new' THEN true ELSE false END,
  can_edit=CASE WHEN
    m.code IN ('appointments','appointments.calendar','appointments.workorders','customers','customers.clients','customers.crm',
               'team.employees','team.schedule','team.attendance','finance.checkout','finance.transactions','finance.workorders',
               'inventory.stock','inventory.transfers','inventory.usage','procurement.orders','procurement.suppliers','procurement.prices')
    OR m.route IN ('/workorders','/workorders/list') THEN true ELSE false END,
  can_delete=false,can_approve=false,
  can_export=CASE WHEN m.code IN ('dashboard','appointments.workorders','finance.transactions','finance.workorders','inventory.stock','procurement.orders') THEN true ELSE false END,
  can_view_financial=CASE WHEN m.code IN ('dashboard','finance','finance.checkout','finance.transactions','finance.cash','finance.workorders') THEN true ELSE false END,
  can_manage_permissions=false,scope_type='own_location',updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='location_manager' AND COALESCE(m.is_active,true) AND (
  m.code IN ('dashboard','appointments','customers','team','finance','inventory','procurement','knowledge')
  OR m.code LIKE 'appointments.%'
  OR m.code LIKE 'customers.%'
  OR m.code IN ('team.employees','team.schedule','team.attendance','team.vacations')
  OR m.code IN ('finance.checkout','finance.transactions','finance.cash','finance.workorders')
  OR m.code IN ('inventory.products','inventory.stock','inventory.transfers','inventory.usage')
  OR m.code IN ('procurement.dashboard','procurement.suggestions','procurement.orders','procurement.suppliers','procurement.prices','procurement.central_supply')
  OR m.code LIKE 'knowledge.%'
  OR m.route IN ('/','/appointments/calendar','/workorders','/workorders/list','/workorders/new','/employees',
                 '/modules/team/timetable','/modules/team/attendance','/modules/customers/clients','/modules/customers/crm',
                 '/warehouse','/warehouse/products','/warehouse/central-supply','/knowledge-base/checklists')
);

-- SZALONVEZETŐ – saját telephely, operatív READ-ONLY.
UPDATE role_menu_permissions p SET
  can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,
  scope_type='own_location',updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='salon_manager' AND COALESCE(m.is_active,true) AND (
  m.code IN ('dashboard','appointments','customers','team','inventory','procurement','knowledge','appointments.workorders')
  OR m.code LIKE 'appointments.%'
  OR m.code LIKE 'customers.%'
  OR m.code IN ('team.employees','team.schedule','team.attendance','team.vacations')
  OR m.code IN ('inventory.products','inventory.stock')
  OR m.code IN ('procurement.dashboard','procurement.central_supply')
  OR m.code LIKE 'knowledge.%'
  OR m.route IN ('/','/appointments/calendar','/workorders','/workorders/list','/employees',
                 '/modules/team/timetable','/modules/team/attendance','/modules/customers/clients','/modules/customers/crm',
                 '/warehouse','/warehouse/products','/warehouse/central-supply','/knowledge-base/checklists')
);

-- RECEPCIÓ – saját telephely operáció + pénztár; nincs bér, NAV, audit vagy permission admin.
UPDATE role_menu_permissions p SET
  can_view=true,
  can_create=CASE WHEN
    m.code IN ('appointments','appointments.calendar','appointments.workorders','customers','customers.clients','customers.crm',
               'finance.checkout','finance.transactions','finance.workorders','inventory.transfers','inventory.usage',
               'procurement.suggestions','procurement.orders','procurement.suppliers')
    OR m.route='/workorders/new' THEN true ELSE false END,
  can_edit=CASE WHEN
    m.code IN ('appointments','appointments.calendar','appointments.workorders','customers','customers.clients','customers.crm',
               'finance.checkout','finance.transactions','finance.workorders','inventory.stock','inventory.transfers','inventory.usage',
               'procurement.orders','procurement.suppliers','procurement.prices')
    OR m.route IN ('/workorders','/workorders/list') THEN true ELSE false END,
  can_delete=false,can_approve=false,
  can_export=CASE WHEN m.code IN ('appointments.workorders','finance.transactions','finance.workorders','inventory.stock','procurement.orders') THEN true ELSE false END,
  can_view_financial=CASE WHEN m.code IN ('finance','finance.checkout','finance.transactions','finance.cash','finance.workorders') THEN true ELSE false END,
  can_manage_permissions=false,scope_type='own_location',updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='receptionist' AND COALESCE(m.is_active,true) AND (
  m.code IN ('dashboard','appointments','customers','loyalty','team','finance','inventory','procurement','knowledge','appointments.workorders')
  OR m.code LIKE 'appointments.%'
  OR m.code LIKE 'customers.%'
  OR m.code LIKE 'loyalty.%'
  OR m.code IN ('team.employees','team.schedule','team.attendance','team.vacations')
  OR m.code IN ('finance.checkout','finance.transactions','finance.cash','finance.workorders')
  OR m.code IN ('inventory.products','inventory.stock','inventory.transfers','inventory.usage')
  OR m.code IN ('procurement.dashboard','procurement.suggestions','procurement.orders','procurement.suppliers','procurement.prices','procurement.central_supply')
  OR m.code LIKE 'knowledge.%'
  OR m.route IN ('/','/appointments/calendar','/workorders','/workorders/list','/workorders/new','/employees',
                 '/modules/team/timetable','/modules/team/attendance','/modules/customers/clients','/modules/customers/crm',
                 '/loyalty','/warehouse','/warehouse/products','/warehouse/central-supply','/knowledge-base/checklists')
);

-- MUNKATÁRS – csak saját nézetek, munkalap READ-ONLY, checklist és chat.
UPDATE role_menu_permissions p SET
  can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,
  scope_type='own',updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='employee' AND COALESCE(m.is_active,true) AND (
  m.code IN ('dashboard','appointments.workorders','team','team.schedule','team.attendance','knowledge','knowledge.checklists')
  OR m.code LIKE 'knowledge.%'
  OR m.route IN ('/','/workorders','/workorders/list','/modules/team/timetable','/modules/team/attendance','/knowledge-base/checklists','/staff/chat')
);

-- ÜGYFÉL – saját irányítópult/foglalás/munkalap/hűség. A tényleges adat-scope-ot a cél API is ellenőrzi.
UPDATE role_menu_permissions p SET
  can_view=true,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,
  scope_type='own',updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key='customer' AND COALESCE(m.is_active,true) AND (
  m.code IN ('dashboard','appointments.workorders','loyalty') OR m.code LIKE 'loyalty.%'
  OR m.route IN ('/','/customer/booking','/workorders','/workorders/list','/loyalty')
);

-- Soha ne legyen nem-admin jogosultságkezelés/NAV/szenzitív admin felület.
UPDATE role_menu_permissions p SET
  can_view=false,can_create=false,can_edit=false,can_delete=false,can_approve=false,
  can_export=false,can_view_financial=false,can_manage_permissions=false,updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND p.role_key<>'admin' AND (
  m.code IN ('settings.access','finance.nav_online_invoice')
  OR m.route IN ('/admin/access-control','/modules/team/roles','/finance/nav-online-invoice')
);

-- Feature-mátrix: először minden ismert feature explicit tiltott a nem-admin szerepköröknek.
WITH features AS (
  SELECT DISTINCT feature_key FROM menus WHERE COALESCE(feature_key,'')<>''
  UNION SELECT * FROM unnest(ARRAY[
    'finance','hr','ai_use','ai_stats','staff_chat','staff_chat_all','inventory','procurement',
    'management_dashboard','audit','appointments','customers','crm','checklists','workorders','loyalty','website_admin'
  ])
)
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
SELECT r.role_key,f.feature_key,false,r.scope_type,now()
FROM (VALUES
 ('manager','all_locations'),('location_manager','own_location'),('salon_manager','own_location'),
 ('receptionist','own_location'),('employee','own'),('customer','own')
) r(role_key,scope_type)
CROSS JOIN features f
ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=false,scope_type=EXCLUDED.scope_type,updated_at=now();

-- Admin minden feature-re engedélyezett.
WITH features AS (
  SELECT DISTINCT feature_key FROM menus WHERE COALESCE(feature_key,'')<>''
  UNION SELECT * FROM unnest(ARRAY[
    'finance','hr','ai_use','ai_stats','staff_chat','staff_chat_all','inventory','procurement',
    'management_dashboard','audit','appointments','customers','crm','checklists','workorders','loyalty','website_admin'
  ])
)
INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
SELECT 'admin',feature_key,true,'all_locations',now() FROM features
ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=true,scope_type='all_locations',updated_at=now();

-- Explicit feature grantok.
UPDATE role_feature_permissions SET can_use=true,scope_type='all_locations',updated_at=now()
WHERE role_key='manager' AND feature_key IN (
  'finance','hr','ai_use','ai_stats','staff_chat','staff_chat_all','inventory','procurement',
  'management_dashboard','audit','appointments','customers','crm','checklists','workorders','loyalty','website_admin'
);
UPDATE role_feature_permissions SET can_use=true,scope_type='own_location',updated_at=now()
WHERE role_key='location_manager' AND feature_key IN (
  'finance','hr','ai_use','staff_chat','inventory','procurement','management_dashboard',
  'appointments','customers','crm','checklists','workorders','loyalty'
);
UPDATE role_feature_permissions SET can_use=true,scope_type='own_location',updated_at=now()
WHERE role_key='salon_manager' AND feature_key IN (
  'hr','ai_use','staff_chat','inventory','appointments','customers','crm','checklists','workorders','loyalty'
);
UPDATE role_feature_permissions SET can_use=true,scope_type='own_location',updated_at=now()
WHERE role_key='receptionist' AND feature_key IN (
  'finance','ai_use','staff_chat','inventory','procurement','appointments','customers','crm','checklists','workorders','loyalty'
);
UPDATE role_feature_permissions SET can_use=true,scope_type='own',updated_at=now()
WHERE role_key='employee' AND feature_key IN ('ai_use','staff_chat','checklists','workorders');
UPDATE role_feature_permissions SET can_use=true,scope_type='own',updated_at=now()
WHERE role_key='customer' AND feature_key IN ('workorders','loyalty');

-- Végső invariantok.
-- 1) Munkalap szerkesztés csak admin, recepció, üzletvezető.
UPDATE role_menu_permissions p SET can_create=false,can_edit=false,can_delete=false,updated_at=now()
FROM menus m
WHERE p.menu_id=m.id AND m.code='appointments.workorders'
  AND p.role_key IN ('manager','salon_manager','employee','customer');
-- Központi manager munkalaphoz továbbra is vezetői felügyeletet kap, de közvetlen szerkesztést nem.
UPDATE role_menu_permissions p SET can_view=true,can_export=true,scope_type='all_locations',updated_at=now()
FROM menus m WHERE p.menu_id=m.id AND m.code='appointments.workorders' AND p.role_key='manager';
-- 2) Checkout módosítás saját szalonban: üzletvezető + recepció; szalonvezető nem.
UPDATE role_menu_permissions p SET can_view=true,can_create=true,can_edit=true,can_delete=false,can_view_financial=true,scope_type='own_location',updated_at=now()
FROM menus m WHERE p.menu_id=m.id AND m.code='finance.checkout' AND p.role_key IN ('location_manager','receptionist');
UPDATE role_menu_permissions p SET can_view=false,can_create=false,can_edit=false,can_delete=false,can_view_financial=false,updated_at=now()
FROM menus m WHERE p.menu_id=m.id AND m.code='finance.checkout' AND p.role_key IN ('salon_manager','employee','customer');

-- Csak a teljes mátrix sikeres felépítése után aktiváljuk a fail-closed middleware-eket.
INSERT INTO schema_migrations(version,description)
VALUES('20260810_RBAC_FAIL_CLOSED_V1','Teljes kanonikus szerepkör-mátrix és fail-closed RBAC aktiválás')
ON CONFLICT(version) DO UPDATE SET description=EXCLUDED.description;

COMMIT;

-- Ellenőrző lekérdezések:
-- SELECT role_key,count(*) FROM role_menu_permissions GROUP BY role_key ORDER BY role_key;
-- SELECT p.role_key,m.code,p.can_view,p.can_create,p.can_edit,p.can_view_financial,p.scope_type
-- FROM role_menu_permissions p JOIN menus m ON m.id=p.menu_id
-- WHERE m.code IN ('appointments.workorders','finance.checkout','finance.nav_online_invoice','settings.access')
-- ORDER BY m.code,p.role_key;
