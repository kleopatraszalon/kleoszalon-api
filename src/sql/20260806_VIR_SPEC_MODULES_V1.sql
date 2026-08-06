BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS vir_module_definitions (
  module_key text PRIMARY KEY,
  title text NOT NULL,
  category text NOT NULL,
  route text NOT NULL,
  description text,
  entity_label text NOT NULL DEFAULT 'bejegyzés',
  icon text,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  statuses jsonb NOT NULL DEFAULT '["draft","active","closed"]'::jsonb,
  spec_reference text,
  order_index integer NOT NULL DEFAULT 100,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vir_module_definitions_route_uq
  ON vir_module_definitions(lower(route));

CREATE TABLE IF NOT EXISTS vir_module_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text NOT NULL REFERENCES vir_module_definitions(module_key) ON UPDATE CASCADE,
  location_id text,
  title text NOT NULL,
  reference_no text,
  status text NOT NULL DEFAULT 'draft',
  priority text NOT NULL DEFAULT 'normal',
  due_at timestamptz,
  amount numeric(14,2),
  currency text NOT NULL DEFAULT 'HUF',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vir_module_records_reference_uq
  ON vir_module_records(module_key, reference_no)
  WHERE reference_no IS NOT NULL;
CREATE INDEX IF NOT EXISTS vir_module_records_lookup_idx
  ON vir_module_records(module_key, is_active, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS vir_module_records_location_idx
  ON vir_module_records(location_id, module_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS vir_module_records_payload_gin
  ON vir_module_records USING gin(payload);

CREATE TABLE IF NOT EXISTS vir_record_audit (
  id bigserial PRIMARY KEY,
  record_id uuid,
  module_key text NOT NULL,
  action text NOT NULL,
  actor_id text,
  location_id text,
  before_data jsonb,
  after_data jsonb,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vir_record_audit_lookup_idx
  ON vir_record_audit(module_key, record_id, created_at DESC);

-- A meglévő Altegio-kompatibilis menük megmaradnak. A specifikáció hiányzó
-- területei új, adatbázis-alapú menücsoportokként egészülnek ki.
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES
  ('operations','Működés és minőség','ClipboardCheck',NULL,55,NULL,'operations',true),
  ('knowledge','Tudásbázis','BookOpenText',NULL,115,NULL,'knowledge_base',true),
  ('masterdata','Törzsadatok','Database',NULL,145,NULL,'master_data',true)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name, icon=EXCLUDED.icon, route=EXCLUDED.route,
  order_index=EXCLUDED.order_index, parent_id=NULL,
  feature_key=EXCLUDED.feature_key, is_active=true;

WITH items(code,parent_code,name,route,order_index,feature_key) AS (
  VALUES
    ('operations.tasks','operations','Teendők és jóváhagyások','/extra/tasks',10,'tasks'),
    ('operations.maintenance','operations','Karbantartások és szervizek','/spec/maintenance',20,'maintenance'),
    ('operations.documents','operations','Elektronikus dokumentumtár','/extra/documents',30,'documents'),
    ('operations.chat','operations','Belső chat','/extra/chat',40,'internal_chat'),
    ('operations.email','operations','Belső e-mail','/spec/internal-email',50,'internal_email'),
    ('operations.complaints','operations','Panaszkezelés','/marketing/complaints',60,'complaints'),

    ('knowledge.base','knowledge','Tudásbázis','/knowledge-base',10,'knowledge_base'),
    ('knowledge.procedures','knowledge','Folyamatok és szabályzatok','/spec/procedures',20,'procedures'),

    ('masterdata.user-groups','masterdata','Felhasználói csoportok','/spec/user-groups',10,'user_groups'),
    ('masterdata.users','masterdata','Felhasználók','/masters/users',20,'users'),
    ('masterdata.departments','masterdata','Részlegek','/masterdata/departments',30,'departments'),
    ('masterdata.service-types','masterdata','Szolgáltatástípusok','/masterdata/service-types',40,'service_types'),
    ('masterdata.product-types','masterdata','Terméktípusok','/masterdata/product-types',50,'product_types'),
    ('masterdata.assets','masterdata','Eszközök és eszköztípusok','/masterdata/assets',60,'assets'),
    ('masterdata.discounts','masterdata','Kedvezménytörzs','/masterdata/discounts',70,'discounts'),
    ('masterdata.leave-types','masterdata','Szabadságtípusok','/spec/leave-types',80,'leave_types'),
    ('masterdata.units','masterdata','Mennyiségi egységek','/masterdata/units',90,'units'),
    ('masterdata.price-types','masterdata','Ártípusok','/masterdata/price-types',100,'price_types'),
    ('masterdata.warehouses','masterdata','Raktárak','/spec/warehouses',110,'warehouses'),
    ('masterdata.movement-types','masterdata','Készletmozgás-típusok','/masterdata/movement-types',120,'movement_types'),
    ('masterdata.transaction-types','masterdata','Pénzügyi tranzakciótípusok','/spec/financial-transaction-types',130,'financial_transaction_types'),
    ('masterdata.guest-account-types','masterdata','Vendégszámla-tranzakciótípusok','/spec/guest-account-transaction-types',140,'guest_account_transaction_types'),

    ('team.recruitment','team','Toborzás és jelentkezések','/hr/applications',75,'recruitment'),
    ('team.training','team','Képzések és képesítések','/spec/training',80,'training'),
    ('team.evaluations','team','Dolgozói értékelések','/hr/evaluations',90,'staff_evaluations'),

    ('finance.incoming-invoices','finance','Bejövő számlák','/finance/invoices/in',75,'incoming_invoices'),
    ('finance.outgoing-invoices','finance','Kimenő számlák','/finance/invoices/out',80,'outgoing_invoices'),
    ('finance.guest-account','finance','Vendégszámla-tranzakciók','/finance/transactions/guest',85,'guest_account_transactions'),
    ('finance.balance-topup','finance','Egyenlegfeltöltés','/finance/balance/topup',90,'balance_topup'),

    ('inventory.orders','inventory','Üzleti és központi megrendelések','/spec/inventory-orders',75,'inventory_orders'),

    ('marketing.newsletter','marketing','Hírlevelek','/marketing/newsletter',60,'newsletter'),
    ('marketing.daily-deals','marketing','Napi akciók','/marketing/daily-deals',70,'daily_deals'),

    ('analytics.profit','analytics','Profitkimutatás','/reports/profit',100,'profit_report'),
    ('analytics.stock-movements','analytics','Készletmozgás-kimutatás','/reports/stock-movements',110,'stock_movement_report'),
    ('analytics.expected-revenue','analytics','Elvárt bevétel','/reports/expected-revenue',120,'expected_revenue'),
    ('analytics.report-editor','analytics','Jelentésszerkesztő','/reports/custom',130,'report_editor')
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT i.code,i.name,NULL,i.route,i.order_index,p.id,i.feature_key,true
FROM items i
JOIN menus p ON p.code=i.parent_code
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name, route=EXCLUDED.route, order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id, feature_key=EXCLUDED.feature_key, is_active=true;

UPDATE menus
SET name='Pénztárnyitás, zárás és ellenőrzés', feature_key='cash_audit', is_active=true
WHERE code='finance.cash';

UPDATE menus
SET name='Szalonhasználat', feature_key='salon_use', is_active=true
WHERE code='inventory.usage';

-- Az egyes modulok mezőleírása a frontend dinamikus, mégis üzleti
-- jelentésű űrlapjait hajtja meg. Új mező később adatbázisból adható hozzá.
INSERT INTO vir_module_definitions
  (module_key,title,category,route,description,entity_label,icon,fields,statuses,spec_reference,order_index)
VALUES
('tasks','Teendők és jóváhagyások','Működés és minőség','/extra/tasks','Műszakhoz, részleghez vagy munkatárshoz rendelt, ismételhető és vezető által jóváhagyható feladatok.','feladat','ClipboardCheck',
 '[{"key":"assignee","label":"Felelős / részleg","type":"text","required":true},{"key":"shift","label":"Műszak","type":"select","options":["délelőtt","délután","egész nap"]},{"key":"recurrence","label":"Ismétlődés","type":"select","options":["egyszeri","heti","havi","éves"]},{"key":"approval_required","label":"Vezetői jóváhagyás szükséges","type":"checkbox"}]'::jsonb,
 '["draft","assigned","in_progress","completed","approved","cancelled"]'::jsonb,'Spec. 13. Teendők',10),
('maintenance','Karbantartások és szervizek','Működés és minőség','/spec/maintenance','Szalon- és eszközkarbantartások határidőkkel, költséggel és megoldási státusszal.','karbantartás','Wrench',
 '[{"key":"asset","label":"Eszköz / terület","type":"text","required":true},{"key":"vendor","label":"Szervizpartner","type":"text"},{"key":"service_date","label":"Szerviz dátuma","type":"date"},{"key":"next_service","label":"Következő szerviz","type":"date"},{"key":"resolution","label":"Megoldás","type":"textarea"}]'::jsonb,
 '["reported","scheduled","in_progress","resolved","cancelled"]'::jsonb,'Spec. 3.1.3 és 3.10.3',20),
('documents','Elektronikus dokumentumtár','Működés és minőség','/extra/documents','Szerződések, igazolások, számlák, képesítések és egyéb dokumentumok nyilvántartása.','dokumentum','Files',
 '[{"key":"category","label":"Kategória","type":"select","options":["szerződés","igazolás","számla","képesítés","szabályzat","egyéb"]},{"key":"owner","label":"Tulajdonos / kapcsolódó rekord","type":"text"},{"key":"file_url","label":"Fájl hivatkozása","type":"url"},{"key":"valid_until","label":"Érvényes eddig","type":"date"}]'::jsonb,
 '["draft","valid","expiring","expired","archived"]'::jsonb,'Spec. 17. Elektronikus dokumentum-nyilvántartás',30),
('internal-chat','Belső chat','Működés és minőség','/extra/chat','Szalonon belüli, jogosultsággal szalonok között is használható belső üzenetküldés.','üzenet','MessagesSquare',
 '[{"key":"recipient","label":"Címzett munkatárs / részleg","type":"text","required":true},{"key":"message","label":"Üzenet","type":"textarea","required":true},{"key":"cross_location","label":"Másik szalonnak küldhető","type":"checkbox"}]'::jsonb,
 '["sent","delivered","read","archived"]'::jsonb,'Spec. 14.1. Gyors üzenet',40),
('internal-email','Belső e-mail','Működés és minőség','/spec/internal-email','Kollégáknak és külső címekre küldendő e-mailek előkészítése és nyomon követése.','levél','Mail',
 '[{"key":"recipients","label":"Címzettek","type":"text","required":true},{"key":"subject","label":"Tárgy","type":"text","required":true},{"key":"body","label":"Levél szövege","type":"textarea","required":true}]'::jsonb,
 '["draft","queued","sent","failed","archived"]'::jsonb,'Spec. 14.2. Belső e-mail',50),
('complaints','Panaszkezelés','Működés és minőség','/marketing/complaints','Üzletben vagy e-mailben érkezett vendégpanaszok kivizsgálása és lezárása.','panasz','MessageSquareWarning',
 '[{"key":"client","label":"Vendég","type":"text"},{"key":"subject","label":"Panasz tárgya","type":"select","options":["kolléga miatt","várakozás miatt","szolgáltatás miatt","egyéb"]},{"key":"source","label":"Forrás","type":"select","options":["személyes","telefon","e-mail","online"]},{"key":"description","label":"Leírás","type":"textarea","required":true},{"key":"resolution","label":"Intézkedés / megoldás","type":"textarea"}]'::jsonb,
 '["new","investigating","accepted","rejected","resolved"]'::jsonb,'Spec. 8. Panaszok kezelése',60),
('knowledge-base','Tudásbázis','Tudásbázis','/knowledge-base','Belső eljárások, szabályzatok és oktatóanyagok kereshető központi tudástára, AI-integrációra előkészített adatmodellel.','tudásanyag','BookOpenText',
 '[{"key":"category","label":"Kategória","type":"select","options":["szolgáltatás","HR","pénzügy","raktár","értékesítés","biztonság","szabályzat"]},{"key":"content","label":"Tartalom","type":"textarea","required":true},{"key":"tags","label":"Címkék","type":"text"},{"key":"source","label":"Forrás","type":"text"}]'::jsonb,
 '["draft","review","published","archived"]'::jsonb,'Kiegészítő vezetői igény + elektronikus dokumentumtár',70),
('procedures','Folyamatok és szabályzatok','Tudásbázis','/spec/procedures','Jóváhagyott belső folyamatok, ellenőrzőlisták és munkautasítások.','eljárás','Workflow',
 '[{"key":"owner","label":"Folyamatgazda","type":"text"},{"key":"version","label":"Verzió","type":"text"},{"key":"steps","label":"Lépések","type":"textarea","required":true},{"key":"review_date","label":"Felülvizsgálat dátuma","type":"date"}]'::jsonb,
 '["draft","review","approved","obsolete"]'::jsonb,'Spec. 17. dokumentumok és általános folyamatnapló',80),
('user-groups','Felhasználói csoportok','Törzsadatok','/spec/user-groups','Jogosultsági csoportok és szervezeti hozzáférési szintek.','felhasználói csoport','ShieldCheck',
 '[{"key":"description","label":"Leírás","type":"textarea"},{"key":"level","label":"Jogosultsági szint","type":"number"},{"key":"location_scope","label":"Telephely-hatókör","type":"select","options":["saját","kijelölt","összes"]}]'::jsonb,
 '["active","inactive"]'::jsonb,'Spec. 3.2. Felhasználó csoportok',90),
('leave-types','Szabadságtípusok','Törzsadatok','/spec/leave-types','Fizetett, fizetés nélküli, beteg- és egyéb távolléttípusok.','szabadságtípus','CalendarOff',
 '[{"key":"code","label":"Kód","type":"text","required":true},{"key":"paid","label":"Fizetett távollét","type":"checkbox"},{"key":"annual_limit","label":"Éves keret (nap)","type":"number"},{"key":"approval_required","label":"Jóváhagyás szükséges","type":"checkbox"}]'::jsonb,
 '["active","inactive"]'::jsonb,'Spec. 3.14. Szabadság típusok',100),
('warehouses','Raktárak','Törzsadatok','/spec/warehouses','Központi és szalonraktárak, jogosultsági és alapértelmezett beállításokkal.','raktár','Warehouse',
 '[{"key":"location","label":"Telephely","type":"text"},{"key":"central","label":"Központi raktár","type":"checkbox"},{"key":"default_purchase","label":"Beszerzéshez alapértelmezett","type":"checkbox"},{"key":"address","label":"Cím","type":"text"}]'::jsonb,
 '["active","inactive"]'::jsonb,'Spec. 3.17. Raktárak',110),
('financial-transaction-types','Pénzügyi tranzakciótípusok','Törzsadatok','/spec/financial-transaction-types','Bevételi, kiadási és átvezetési jogcímek pénztár-eltérés beállításokkal.','tranzakciótípus','ArrowLeftRight',
 '[{"key":"direction","label":"Irány","type":"select","options":["bevétel","kiadás","átvezetés"]},{"key":"payment_method","label":"Fizetési mód","type":"text"},{"key":"partner_required","label":"Partner kötelező","type":"checkbox"},{"key":"cash_difference_role","label":"Pénztáreltérés szerepe","type":"select","options":["nincs","nyitási hiány","zárási hiány","nyitási többlet","zárási többlet"]}]'::jsonb,
 '["active","inactive"]'::jsonb,'Spec. 3.20. Pénzügyi tranzakció típusok',120),
('guest-account-transaction-types','Vendégszámla-tranzakciótípusok','Törzsadatok','/spec/guest-account-transaction-types','Vendégegyenleg feltöltési, terhelési és korrekciós jogcímek.','vendégszámla-típus','BadgeDollarSign',
 '[{"key":"direction","label":"Irány","type":"select","options":["jóváírás","terhelés","korrekció"]},{"key":"financial_type","label":"Kapcsolt pénzügyi jogcím","type":"text"}]'::jsonb,
 '["active","inactive"]'::jsonb,'Spec. 3.21. Vendég számla tranzakciók',130),
('recruitment','Toborzás és jelentkezések','Csapat és HR','/hr/applications','Álláshirdetések, jelöltek, interjúk és próbanapok teljes kiválasztási folyamata.','jelentkezés','UserRoundSearch',
 '[{"key":"position","label":"Pozíció","type":"text","required":true},{"key":"applicant","label":"Jelölt neve","type":"text","required":true},{"key":"email","label":"E-mail","type":"email"},{"key":"phone","label":"Telefon","type":"tel"},{"key":"interview_date","label":"Interjú időpontja","type":"datetime-local"},{"key":"trial_date","label":"Próbanap","type":"date"},{"key":"cv_url","label":"Önéletrajz hivatkozása","type":"url"}]'::jsonb,
 '["new","contacted","interview","trial_day","hired","rejected"]'::jsonb,'Spec. HR jelentkezések és 9. Pozíció feltöltése',140),
('training','Képzések és képesítések','Csapat és HR','/spec/training','Dolgozói képesítések, szintek, oktatások és értesítendő képzési események.','képzés','GraduationCap',
 '[{"key":"employee","label":"Munkatárs","type":"text","required":true},{"key":"qualification","label":"Képesítés / képzés","type":"text","required":true},{"key":"level","label":"Szint","type":"select","options":["1","2","3"]},{"key":"training_date","label":"Időpont","type":"datetime-local"},{"key":"provider","label":"Képzőhely","type":"text"}]'::jsonb,
 '["planned","notified","completed","expired","cancelled"]'::jsonb,'Spec. Felhasználók - képesítés és képzés',150),
('staff-evaluations','Dolgozói értékelések','Csapat és HR','/hr/evaluations','Havi belső és vendégértékelések, vezetői jóváhagyással.','értékelés','Star',
 '[{"key":"employee","label":"Munkatárs","type":"text","required":true},{"key":"period","label":"Időszak","type":"month"},{"key":"score","label":"Pontszám (1-5)","type":"number"},{"key":"red_points","label":"Piros pontok","type":"number"},{"key":"black_points","label":"Fekete pontok","type":"number"},{"key":"note","label":"Indoklás","type":"textarea"}]'::jsonb,
 '["draft","submitted","approved","published"]'::jsonb,'Spec. 16. Értékelés',160),
('incoming-invoices','Bejövő számlák','Pénzügy','/finance/invoices/in','Bejövő számlák melléklettel, devizával, határidővel és költséghellyel.','bejövő számla','ReceiptText',
 '[{"key":"supplier","label":"Beszállító","type":"text","required":true},{"key":"invoice_number","label":"Számlaszám","type":"text","required":true},{"key":"issue_date","label":"Kiállítás dátuma","type":"date"},{"key":"payment_due","label":"Fizetési határidő","type":"date"},{"key":"cost_center","label":"Szalon / költséghely","type":"text"},{"key":"attachment_url","label":"Számlakép hivatkozása","type":"url"}]'::jsonb,
 '["draft","registered","approved","paid","overdue","cancelled"]'::jsonb,'Spec. 7.3. Bejövő számlák',170),
('cash-audit','Pénztárnyitás, zárás és ellenőrzés','Pénzügy','/finance/cash','Kassza- és bankállások címletenkénti nyitása, zárása és műszakváltási ellenőrzése.','pénztárellenőrzés','Landmark',
 '[{"key":"cash_register","label":"Pénztár / bank","type":"text","required":true},{"key":"action","label":"Művelet","type":"select","options":["nyitás","zárás","ellenőrzés"]},{"key":"expected_amount","label":"Elvárt összeg","type":"number"},{"key":"counted_amount","label":"Megszámolt összeg","type":"number"},{"key":"difference_reason","label":"Eltérés oka","type":"textarea"}]'::jsonb,
 '["draft","counted","difference","approved","closed"]'::jsonb,'Spec. 7.1.4. Pénztár nyitás/zárás/ellenőrzés',180),
('inventory-orders','Üzleti és központi megrendelések','Raktár és készlet','/spec/inventory-orders','Szalonból központba, majd beszállítóhoz futó megrendelési és érkeztetési folyamat.','megrendelés','PackageSearch',
 '[{"key":"supplier","label":"Beszállító","type":"text"},{"key":"source_warehouse","label":"Forrásraktár","type":"text"},{"key":"destination_warehouse","label":"Célraktár","type":"text","required":true},{"key":"items","label":"Termékek és mennyiségek","type":"textarea","required":true},{"key":"expected_date","label":"Várható érkezés","type":"date"}]'::jsonb,
 '["draft","submitted","central_review","ordered","partially_received","sent_to_salon","received","cancelled"]'::jsonb,'Spec. 6.1-6.4. Logisztika',190),
('daily-deals','Napi akciók','Kommunikáció és marketing','/marketing/daily-deals','Szabad kapacitás alapján létrehozott, jóváhagyható napi szolgáltatásakciók.','napi akció','BadgePercent',
 '[{"key":"department","label":"Részleg","type":"text"},{"key":"service","label":"Szolgáltatás","type":"text","required":true},{"key":"discount_percent","label":"Kedvezmény (%)","type":"number"},{"key":"valid_date","label":"Érvényesség napja","type":"date"},{"key":"channels","label":"Megjelenési csatornák","type":"text"}]'::jsonb,
 '["suggested","approved","published","expired","rejected"]'::jsonb,'Spec. Napi akciók és TV megjelenítés',200),
('report-editor','Jelentésszerkesztő','Statisztika és VIR','/reports/custom','Menthető, ütemezhető és PDF/Excel formátumban exportálható vezetői jelentések.','jelentés','FileChartColumn',
 '[{"key":"report_type","label":"Jelentéstípus","type":"select","options":["profit","készletmozgás","elvárt bevétel","munkaidő","értékelés","egyedi"]},{"key":"filters","label":"Szűrési feltételek","type":"textarea"},{"key":"schedule","label":"Küldési ütemezés","type":"text"},{"key":"recipients","label":"E-mail címzettek","type":"text"},{"key":"format","label":"Formátum","type":"select","options":["PDF","Excel","mindkettő"]}]'::jsonb,
 '["draft","active","paused","archived"]'::jsonb,'Spec. 10. Cégműszerfal és 15.4. Jelentésszerkesztő',210)
ON CONFLICT(module_key) DO UPDATE SET
  title=EXCLUDED.title, category=EXCLUDED.category, route=EXCLUDED.route,
  description=EXCLUDED.description, entity_label=EXCLUDED.entity_label,
  icon=EXCLUDED.icon, fields=EXCLUDED.fields, statuses=EXCLUDED.statuses,
  spec_reference=EXCLUDED.spec_reference, order_index=EXCLUDED.order_index,
  is_active=true, updated_at=now();

-- A menüből érkező, de külön mezősémával még nem rendelkező funkciók is
-- azonnal használhatók egy alap leírás/felelős/határidő adatlappal.
INSERT INTO vir_module_definitions(module_key,title,category,route,description,entity_label,fields,statuses,spec_reference,order_index)
SELECT
  replace(m.code,'.','-'), m.name, COALESCE(p.name,'Kleoszalon VIR'), m.route,
  'Adatbázis-alapú kezelőfelület kereséssel, státuszkezeléssel, naplózással és CSV-exporttal.',
  'bejegyzés',
  '[{"key":"description","label":"Leírás","type":"textarea"},{"key":"owner","label":"Felelős","type":"text"},{"key":"effective_date","label":"Érvényesség / határidő","type":"date"}]'::jsonb,
  '["draft","active","closed","archived"]'::jsonb,
  'Kleoszalon VIR specifikáció', COALESCE(m.order_index,100)
FROM menus m
LEFT JOIN menus p ON p.id=m.parent_id
WHERE m.route IS NOT NULL AND COALESCE(m.is_active,true)
  AND NOT EXISTS (
    SELECT 1 FROM vir_module_definitions d WHERE lower(d.route)=lower(m.route)
  )
ON CONFLICT(module_key) DO NOTHING;

-- Jogosultságok az új menükre. Az admin teljes, a vezető operatív jogot kap;
-- a recepciós és munkatárs csak a napi munkához szükséges modulokat látja.
INSERT INTO role_menu_permissions
  (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations'
FROM menus m
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,
  can_export=true,can_view_financial=true,can_manage_permissions=true,scope_type='all_locations';

INSERT INTO role_menu_permissions
  (role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type)
SELECT 'manager',m.id,true,true,true,false,true,true,true,false,'all_locations'
FROM menus m
WHERE COALESCE(m.code,'') ~ '^(operations|knowledge|masterdata|team|finance|inventory|analytics|marketing)'
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_approve=true,can_export=true,scope_type='all_locations';

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,scope_type)
SELECT 'receptionist',m.id,true,true,true,'own_location'
FROM menus m
WHERE COALESCE(m.code,'') IN ('operations','finance','inventory','marketing')
   OR COALESCE(m.code,'') ~ '^(operations.tasks|operations.chat|operations.complaints|knowledge|finance.incoming-invoices|inventory.orders|marketing.daily-deals)'
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,scope_type='own_location';

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,scope_type)
SELECT 'employee',m.id,true,true,true,'own'
FROM menus m
WHERE COALESCE(m.code,'')='operations'
   OR COALESCE(m.code,'') ~ '^(operations.tasks|operations.chat|knowledge)'
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,scope_type='own';

-- Kevés, életszerű induló rekord teszteléshez. A reference_no miatt a seed idempotens.
INSERT INTO vir_module_records(module_key,title,reference_no,status,priority,due_at,payload,created_by)
VALUES
 ('tasks','Nyitás előtti higiéniai ellenőrzőlista','TASK-DEMO-001','assigned','high',date_trunc('day',now())+interval '8 hour','{"assignee":"Nyitó műszak - kozmetika","shift":"délelőtt","recurrence":"heti","approval_required":true}'::jsonb,'system'),
 ('maintenance','IPL készülék időszakos felülvizsgálata','MAINT-DEMO-001','scheduled','high',now()+interval '14 day','{"asset":"IPL kezelőgép","vendor":"Márkaszerviz","next_service":"2026-08-20"}'::jsonb,'system'),
 ('complaints','Várakozási idő kivizsgálása','COMP-DEMO-001','investigating','normal',now()+interval '3 day','{"client":"Minta Vendég","subject":"várakozás miatt","source":"e-mail","description":"A vendég a vállalt időponthoz képest hosszabb várakozást jelzett."}'::jsonb,'system'),
 ('knowledge-base','Vendég érkezési és munkalapindítási folyamat','KB-DEMO-001','published','normal',NULL,'{"category":"szolgáltatás","content":"Érkezéskor azonosítsa a vendéget, ellenőrizze a foglalást, majd indítsa el a munkalapot. A szolgáltatásokat és termékhasználatot a tényleges teljesítés szerint rögzítse.","tags":"recepció, munkalap, érkezés","source":"VIR specifikáció"}'::jsonb,'system'),
 ('incoming-invoices','Kozmetikai alapanyag beszállítói számla','INV-DEMO-001','registered','normal',now()+interval '8 day','{"supplier":"Minta Beauty Partner Kft.","invoice_number":"KB-2026-0812","payment_due":"2026-08-14","cost_center":"Budapest VIII.","attachment_url":""}'::jsonb,'system')
ON CONFLICT(module_key,reference_no) WHERE reference_no IS NOT NULL DO NOTHING;

INSERT INTO schema_migrations(version,description)
VALUES('20260806_VIR_SPEC_MODULES_V1','VIR specifikációs modulok, adatbázis-alapú menük, rekordok és audit')
ON CONFLICT(version) DO NOTHING;

COMMIT;
