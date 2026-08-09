BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

INSERT INTO hr_positions(code,name,description,management_level,is_active)
SELECT 'ADMIN','Adminisztrátor','VIR rendszerszintű adminisztráció és napi működési kontroll.',100,true
WHERE NOT EXISTS (
  SELECT 1 FROM hr_positions WHERE lower(COALESCE(code,''))='admin'
);

WITH p AS (
  SELECT id FROM hr_positions WHERE lower(COALESCE(code,''))='admin' ORDER BY created_at LIMIT 1
)
UPDATE employees e
SET position_id=p.id,active=true,updated_at=now()
FROM users u,p
WHERE lower(COALESCE(e.email,''))=lower(COALESCE(u.email,''))
  AND lower(COALESCE(u.role::text,'')) LIKE '%admin%';

WITH p AS (
  SELECT id FROM hr_positions WHERE lower(COALESCE(code,''))='admin' ORDER BY created_at LIMIT 1
)
INSERT INTO employees(full_name,email,login_name,role,position_id,active,updated_at)
SELECT COALESCE(NULLIF(u.full_name,''),NULLIF(u.login_name,''),u.email,'Adminisztrátor'),
       u.email,u.login_name,'["admin"]'::jsonb,p.id,true,now()
FROM users u CROSS JOIN p
WHERE lower(COALESCE(u.role::text,'')) LIKE '%admin%'
  AND COALESCE(u.email,'')<>''
  AND NOT EXISTS(SELECT 1 FROM employees e WHERE lower(COALESCE(e.email,''))=lower(u.email));

INSERT INTO vir_checklists(code,name,description,daily_warning_time,weekly_warning_weekday,monthly_warning_days,is_active)
VALUES(
  'admin-core-v1',
  'Admin napi rendszerellenőrzés',
  'A VIR és a szalonhálózat rendszerszintű napi, heti és havi adminisztrátori ellenőrzése.',
  '17:00',3,7,true
)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,description=EXCLUDED.description,is_active=true;

WITH c AS (SELECT id FROM vir_checklists WHERE code='admin-core-v1')
INSERT INTO vir_checklist_items(checklist_id,item_key,frequency,section,title,description,sort_order,is_required,is_active)
SELECT c.id,v.item_key,v.frequency,v.section,v.title,v.description,v.sort_order,true,true
FROM c
CROSS JOIN (VALUES
 ('admin-d-001','daily','Rendszerállapot','API és adatbázis állapot ellenőrzése','A dashboard és a fő üzleti API-k legyenek elérhetők, 500-as hibák nélkül.',10),
 ('admin-d-002','daily','Munkalapok','Nyitott és hibás munkalapok ellenőrzése','Függőben maradt, részben fizetett vagy sikertelenül lezárt munkalapok áttekintése.',20),
 ('admin-d-003','daily','Pénzügy','Függő vagy hibás pénzügyi tranzakciók ellenőrzése','Kiegyenlítetlen, eltéréses vagy lezáratlan pénztári tételek vizsgálata.',30),
 ('admin-d-004','daily','Készlet','Készlethiányok és készletfeltöltési igények áttekintése','0 vagy minimum alatti készlet és nyitott szalonigény ellenőrzése.',40),
 ('admin-d-005','daily','HR és jogosultság','Új vagy hibás felhasználói jogosultságok ellenőrzése','Hiányzó munkakör, telephely vagy túl széles jogosultság ellenőrzése.',50),
 ('admin-d-006','daily','Naptár','Mai időpontok és státuszhibák ellenőrzése','No-show, lemondás, arrived/in_progress státuszok konzisztenciájának ellenőrzése.',60),
 ('admin-d-007','daily','UAT','Napi kritikus UAT hibák áttekintése','A nyitott kritikus teszthibák és regressziók áttekintése.',70),
 ('admin-w-001','weekly','Heti kontroll','Heti üzleti és technikai hibatrend áttekintése','Ismétlődő API-, jogosultság-, készlet- és pénzügyi hibák összegzése.',10),
 ('admin-w-002','weekly','Heti kontroll','Jogosultsági audit mintavétel','Admin, recepciós, üzletvezető, szalonvezető, munkatárs és ügyfél scope ellenőrzése.',20),
 ('admin-w-003','weekly','Heti kontroll','Mentési és adatminőségi ellenőrzés','Törzsadatok, duplikációk és hiányzó kapcsolatok áttekintése.',30),
 ('admin-m-001','monthly','Havi kontroll','Havi VIR állapotriport elkészítése','Modulok, hibák, teljesítmény és fejlesztési backlog összegzése.',10),
 ('admin-m-002','monthly','Havi kontroll','Szerepkör- és menüjogosultság felülvizsgálata','Aktív szerepkörök és menüengedélyek teljes felülvizsgálata.',20),
 ('admin-m-003','monthly','Havi kontroll','Archiválási és auditnapló ellenőrzése','Lezárt munkalapok, auditlogok és pénzügyi nyomvonal mintavételes ellenőrzése.',30)
) AS v(item_key,frequency,section,title,description,sort_order)
ON CONFLICT(checklist_id,item_key) DO UPDATE SET
  frequency=EXCLUDED.frequency,section=EXCLUDED.section,title=EXCLUDED.title,
  description=EXCLUDED.description,sort_order=EXCLUDED.sort_order,is_required=true,is_active=true,updated_at=now();

WITH c AS (SELECT id FROM vir_checklists WHERE code='admin-core-v1'),
     p AS (SELECT id FROM hr_positions WHERE lower(COALESCE(code,''))='admin' ORDER BY created_at LIMIT 1)
INSERT INTO vir_checklist_position_assignments(checklist_id,position_id,is_active)
SELECT c.id,p.id,true FROM c CROSS JOIN p
ON CONFLICT(checklist_id,position_id) DO UPDATE SET is_active=true,updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260809_ADMIN_CHECKLIST_V1','Admin munkakör, admin checklist és admin felhasználó–munkatárs összerendelés')
ON CONFLICT(version) DO NOTHING;

COMMIT;
