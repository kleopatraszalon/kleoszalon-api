BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS uat_test_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  module_key text NOT NULL,
  title text NOT NULL,
  description text,
  expected_result text NOT NULL,
  route text,
  order_index integer NOT NULL DEFAULT 100,
  critical boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uat_test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'open',
  started_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  note text,
  CONSTRAINT uat_test_runs_status_ck CHECK(status IN ('open','completed','cancelled'))
);

CREATE TABLE IF NOT EXISTS uat_test_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES uat_test_runs(id) ON DELETE CASCADE,
  test_case_id uuid NOT NULL REFERENCES uat_test_cases(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not_tested',
  tester text,
  tested_at timestamptz,
  note text,
  evidence text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,test_case_id),
  CONSTRAINT uat_test_results_status_ck CHECK(status IN ('not_tested','passed','failed','blocked','skipped'))
);

INSERT INTO uat_test_cases(code,module_key,title,description,expected_result,route,order_index,critical)
VALUES
('UAT-BOOK-001','booking','Online foglalás létrehozása','Vendég kiválasztja a telephelyet, szolgáltatást, munkatársat és szabad időpontot.','A foglalás létrejön, megjelenik a VIR naptárban és nem keletkezik időpontütközés.','/appointments/calendar',10,true),
('UAT-BOOK-002','booking','Hangalapú foglalás','A vendég hanggal adja meg az igényt, időpontot és elérhetőséget.','A rendszer visszakérdez, megerősítést kér és online_voice forrással ment.','/appointments/calendar',20,false),
('UAT-WO-001','workorders','Munkalap létrehozása és lezárása','Foglalásból vagy kézzel munkalap készül, szolgáltatás és termék kerül rá.','A munkalap összege helyes, lezárható és a CRM frissül.','/workorders',30,true),
('UAT-FIN-001','finance','Fizetés és pénzügyi lezárás','Készpénz/kártya/részfizetés rögzítése, kedvezmény és borravaló kezelése.','A fizetési státusz, kassza és napi összesítők helyesen frissülnek.','/finance',40,true),
('UAT-FIN-002','finance','Munkalapból kimenő számla','Számlát kérő, pénzügyileg lezárt munkalap ellenőrzése.','A kapcsolt kimenő számla automatikusan létrejön és a forrás munkalap azonosítható.','/finance/invoices/out',50,true),
('UAT-PROC-001','procurement','Beszerzés és jóváhagyás','Rendelési javaslatból rendelés, jóváhagyás, rendelésre küldés.','Jóváhagyás nélkül nem rendelhető; jóváhagyás után a státuszok helyesen változnak.','/warehouse?view=procurement&section=orders',60,true),
('UAT-PROC-002','procurement','Bevételezésből bejövő számla','Jóváhagyott rendelés részleges/teljes bevételezése.','Készlet frissül és bejövő számla-piszkozat keletkezik a rendeléshez kapcsolva.','/finance/invoices/in',70,true),
('UAT-PAY-001','payroll','Havi bérszámfejtés','Munkaidő, alapbér, jutalék és adóparaméterek alapján számfejtés készül.','A bruttó, levonások, nettó és munkáltatói költség következetesen számolódik.','/modules/team/payroll?tab=payroll',80,true),
('UAT-PAY-002','payroll','Bérjegyzék PDF és e-mail','Jóváhagyott számfejtésből bérjegyzék készül és kiküldhető.','A PDF létrejön, a küldési státusz és címzett naplózódik.','/modules/team/payroll?tab=payslips',90,true),
('UAT-ACC-001','accounting','Főkönyvi feladás','Jóváhagyott számla vagy bérszámfejtés könyvelési feladása.','Tartozik és Követel oldal egyezik; ugyanaz a forrás nem könyvelhető kétszer.','/modules/team/payroll?tab=accounting',100,true),
('UAT-RBAC-001','access','Jogosultsági ellenőrzés','Admin, manager, receptionist és employee szerepkörök ellenőrzése.','A menük és műveletek szerepkör szerint jelennek meg, tiltott API-művelet elutasításra kerül.','/admin/access-control',110,true),
('UAT-AUDIT-001','audit','Auditnapló ellenőrzése','Pénzügyi, HR és admin művelet végrehajtása.','A művelet felhasználóval, időponttal és telephellyel visszakereshető.','/modules/settings/audit-log',120,false),
('UAT-NOTIF-001','notifications','Értesítési központ','Új chat, készlethiány vagy pénzügyi figyelmeztetés előidézése.','Értesítés létrejön, olvasott/olvasatlan státusz működik.','/dashboard/notifications',130,false),
('UAT-SYS-001','system','Rendszerellenőrzés','A teljes technikai ellenőrző futtatása.','Nincs piros kritikus állapot; a sárga figyelmeztetések dokumentáltak.','/admin/system-health',140,true)
ON CONFLICT(code) DO UPDATE SET
 module_key=EXCLUDED.module_key,title=EXCLUDED.title,description=EXCLUDED.description,
 expected_result=EXCLUDED.expected_result,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
 critical=EXCLUDED.critical,active=true,updated_at=now();

-- A Finance runtime bootstrap a teljes adatbázis mellett minimális integrációs
-- sémán is lefuthat. Az UAT menü ezért maga biztosítja a saját minimális,
-- canonical-kompatibilis menü/RBAC infrastruktúráját, mielőtt azt használja.
CREATE TABLE IF NOT EXISTS menus(
  id bigserial PRIMARY KEY,
  code text,
  name text NOT NULL,
  icon text,
  route text,
  order_index integer NOT NULL DEFAULT 0,
  parent_id bigint,
  feature_key text,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS route text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS order_index integer NOT NULL DEFAULT 0;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS parent_id bigint;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code) WHERE code IS NOT NULL;
-- ON CONFLICT(code) cannot infer a partial unique index; a full unique index
-- still permits multiple NULL codes while providing a valid upsert arbiter.
CREATE UNIQUE INDEX IF NOT EXISTS menus_code_conflict_uq ON menus(code);

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
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_view boolean NOT NULL DEFAULT false;
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_create boolean NOT NULL DEFAULT false;
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_edit boolean NOT NULL DEFAULT false;
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_delete boolean NOT NULL DEFAULT false;
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_approve boolean NOT NULL DEFAULT false;
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_export boolean NOT NULL DEFAULT false;
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_view_financial boolean NOT NULL DEFAULT false;
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_manage_permissions boolean NOT NULL DEFAULT false;
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'own_location';
ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
CREATE UNIQUE INDEX IF NOT EXISTS role_menu_permissions_role_menu_uq ON role_menu_permissions(role_key,menu_id);

DO $$
DECLARE v_parent_id bigint; v_item_id bigint;
BEGIN
  SELECT id INTO v_parent_id FROM menus
  WHERE code='settings' OR lower(name) IN ('beállítások és adminisztráció','beállítások','adminisztráció')
  ORDER BY CASE WHEN code='settings' THEN 0 ELSE 1 END,id LIMIT 1;
  IF v_parent_id IS NULL THEN
    INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
    VALUES('settings','Beállítások és adminisztráció','Settings',NULL,190,NULL,'audit',true)
    ON CONFLICT(code) DO UPDATE SET is_active=true RETURNING id INTO v_parent_id;
  END IF;
  INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
  VALUES('settings.uat','UAT tesztközpont','ClipboardCheck','/admin/uat',195,v_parent_id,'audit',true)
  ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,parent_id=EXCLUDED.parent_id,order_index=EXCLUDED.order_index,is_active=true
  RETURNING id INTO v_item_id;

  INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
  VALUES
  ('admin',v_item_id,true,true,true,false,true,true,true,true,'all_locations',now()),
  ('manager',v_item_id,true,true,true,false,true,true,true,false,'all_locations',now()),
  ('receptionist',v_item_id,false,false,false,false,false,false,false,false,'own_location',now()),
  ('employee',v_item_id,false,false,false,false,false,false,false,false,'own',now())
  ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=EXCLUDED.can_view,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_approve=EXCLUDED.can_approve,can_export=EXCLUDED.can_export,updated_at=now();
END $$;

COMMIT;
