BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- VIR SPECIFIKÁCIÓ V2 – BŐVÍTŐ, VISSZAFELÉ KOMPATIBILIS ALAP
-- A meglévő táblákat és funkciókat nem törli vagy nevezi át.
-- ============================================================

CREATE TABLE IF NOT EXISTS vir_module_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key text NOT NULL,
  record_no text NOT NULL DEFAULT (
    'VIR-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' ||
    upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8))
  ),
  title text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  priority text NOT NULL DEFAULT 'normal',
  location_id uuid,
  department_id uuid,
  employee_id uuid,
  client_id uuid,
  partner_id uuid,
  parent_id uuid REFERENCES vir_module_records(id),
  direction text,
  amount numeric(16,2),
  currency text NOT NULL DEFAULT 'HUF',
  quantity numeric(16,3),
  unit text,
  start_at timestamptz,
  due_at timestamptz,
  completed_at timestamptz,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS vir_module_records_record_no_uq
  ON vir_module_records(record_no);
CREATE INDEX IF NOT EXISTS vir_module_records_module_idx
  ON vir_module_records(module_key, is_active, updated_at DESC);
CREATE INDEX IF NOT EXISTS vir_module_records_location_idx
  ON vir_module_records(location_id, module_key, status);
CREATE INDEX IF NOT EXISTS vir_module_records_due_idx
  ON vir_module_records(due_at) WHERE is_active;
CREATE INDEX IF NOT EXISTS vir_module_records_data_gin
  ON vir_module_records USING gin(data);

CREATE TABLE IF NOT EXISTS vir_record_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id uuid NOT NULL REFERENCES vir_module_records(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_user_id text,
  actor_role text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vir_record_history_record_idx
  ON vir_record_history(record_id, created_at DESC);

CREATE TABLE IF NOT EXISTS vir_knowledge_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  slug text NOT NULL,
  summary text,
  content text NOT NULL,
  category text NOT NULL DEFAULT 'Általános',
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  status text NOT NULL DEFAULT 'draft',
  visibility text NOT NULL DEFAULT 'internal',
  location_id uuid,
  source_url text,
  ai_summary text,
  version integer NOT NULL DEFAULT 1,
  is_active boolean NOT NULL DEFAULT true,
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vir_knowledge_articles_slug_uq
  ON vir_knowledge_articles(slug);
CREATE INDEX IF NOT EXISTS vir_knowledge_articles_search_idx
  ON vir_knowledge_articles USING gin(to_tsvector('simple', title || ' ' || COALESCE(summary,'') || ' ' || content));

CREATE TABLE IF NOT EXISTS vir_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  conversation_type text NOT NULL DEFAULT 'internal',
  location_id uuid,
  created_by text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vir_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES vir_conversations(id) ON DELETE CASCADE,
  sender_type text NOT NULL DEFAULT 'user',
  sender_user_id text,
  content text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vir_messages_conversation_idx
  ON vir_messages(conversation_id, created_at);

CREATE TABLE IF NOT EXISTS vir_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text NOT NULL,
  location_id uuid,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS vir_settings_key_location_uq
  ON vir_settings(setting_key, COALESCE(location_id, '00000000-0000-0000-0000-000000000000'::uuid));

-- ============================================================
-- ADATBÁZIS-ALAPÚ MENÜK – meglévő menük bővítése
-- ============================================================

INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES
  ('operations','Működés és együttműködés','ClipboardCheck',NULL,65,NULL,'operations',true),
  ('knowledge','Tudásbázis és AI','Sparkles',NULL,145,NULL,'ai_knowledge',true)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,feature_key=EXCLUDED.feature_key,is_active=true;

WITH items(code,parent_code,name,route,order_index,feature_key) AS (
  VALUES
    ('finance.transactions','finance','Bevételek és kiadások','/finance/transactions',20,'transactions'),
    ('finance.cash','finance','Pénztár nyitás, zárás és ellenőrzés','/finance/cash-control',30,'cash_management'),
    ('finance.outgoing','finance','Kimenő számlák','/finance/outgoing-invoices',40,'outgoing_invoices'),
    ('finance.incoming','finance','Bejövő számlák','/finance/incoming-invoices',50,'incoming_invoices'),
    ('finance.payments','finance','Fizetések','/finance/payments',60,'payments'),
    ('finance.guest_accounts','finance','Vendégszámla tranzakciók','/finance/guest-accounts',65,'guest_accounts'),

    ('inventory.orders','inventory','Megrendelések','/inventory/orders',25,'stock_orders'),
    ('inventory.receiving','inventory','Bevételezés','/inventory/receipts',30,'stock_receipts'),
    ('inventory.replenishment','inventory','Kiegészítés','/inventory/replenishment',35,'stock_replenishment'),
    ('inventory.transfers','inventory','Raktárközi átadások','/inventory/transfers',40,'stock_transfer'),
    ('inventory.purchase','inventory','Új beszerzés költséggel','/inventory/purchases',45,'stock_purchase'),
    ('inventory.adjustment','inventory','Leltár és készletkorrekció','/inventory/adjustments',50,'stocktaking'),
    ('inventory.usage','inventory','Szalonhasználat és anyagfelhasználás','/inventory/salon-usage',60,'consumption'),

    ('team.jobs','team','Álláshirdetések','/hr/job-postings',65,'job_postings'),
    ('team.applications','team','Jelentkezések és kiválasztás','/hr/applications',70,'job_applications'),
    ('team.performance','team','Teljesítmény és dolgozói értékelés','/hr/evaluations',50,'staff_performance'),

    ('marketing.newsletters','marketing','Hírlevelek','/marketing/newsletters',10,'newsletters'),
    ('marketing.complaints','marketing','Panaszkezelés','/marketing/complaints',45,'complaints'),
    ('marketing.daily_deals','marketing','Napi akciók','/marketing/daily-deals',50,'daily_deals'),
    ('marketing.feedback','marketing','Értékelések és moderáció','/marketing/reviews',55,'feedback'),

    ('analytics.profit','analytics','Profit táblázat','/reports/profit',32,'profit_report'),
    ('analytics.stock_movements','analytics','Készletmozgások lekérdezése','/reports/stock-movements',82,'stock_movement_report'),
    ('analytics.expected_revenue','analytics','Elvárt bevételek','/reports/expected-revenue',84,'expected_revenue'),
    ('analytics.report_editor','analytics','Jelentésszerkesztő','/reports/report-editor',86,'report_editor'),

    ('operations.tasks','operations','Teendők és jóváhagyások','/operations/tasks',10,'tasks'),
    ('operations.chat','operations','Belső chat','/operations/chat',20,'internal_chat'),
    ('operations.mail','operations','Belső és külső e-mail','/operations/mail',30,'internal_mail'),
    ('operations.documents','operations','Elektronikus dokumentumok','/operations/documents',40,'documents'),

    ('knowledge.articles','knowledge','Tudásbázis','/knowledge/articles',10,'knowledge_base'),
    ('knowledge.assistant','knowledge','Kleo AI asszisztens','/knowledge/assistant',20,'ai_assistant'),

    ('settings.departments','settings','Részlegek','/masterdata/departments',12,'departments'),
    ('settings.assets','settings','Eszközök és karbantartás','/masterdata/assets',14,'assets'),
    ('settings.partners','settings','Partnerek és beszállítók','/masterdata/partners',16,'partners'),
    ('settings.units','settings','Mennyiségi egységek','/masterdata/units',18,'units'),
    ('settings.price_types','settings','Ártípusok','/masterdata/price-types',20,'price_types'),
    ('settings.movement_types','settings','Készletmozgás-típusok','/masterdata/movement-types',22,'movement_types'),
    ('settings.payment','settings','Fizetési módok','/masterdata/payment-methods',30,'payment_methods'),
    ('settings.application','settings','Folyamat- és alkalmazásbeállítások','/settings/application',58,'application_settings')
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT i.code,i.name,NULL,i.route,i.order_index,p.id,i.feature_key,true
FROM items i JOIN menus p ON p.code=i.parent_code
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;

-- Az admin mindent lát; a további szerepkörök finomhangolhatók az admin mátrixban.
INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type
)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations'
FROM menus m
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,
  can_export=true,can_view_financial=true,can_manage_permissions=true,scope_type='all_locations';

INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,
  can_export,can_view_financial,can_manage_permissions,scope_type
)
SELECT 'manager',m.id,true,true,true,false,true,true,
       (COALESCE(m.code,'') LIKE 'finance.%' OR COALESCE(m.code,'') LIKE 'analytics.%'),
       false,'all_locations'
FROM menus m
WHERE COALESCE(m.code,'') ~ '^(operations|knowledge|team\.(jobs|applications|performance)|marketing\.(complaints|daily_deals|feedback|newsletters)|finance\.|inventory\.|analytics\.)'
ON CONFLICT(role_key,menu_id) DO NOTHING;

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,scope_type)
SELECT 'employee',m.id,true,true,true,'own_location'
FROM menus m
WHERE COALESCE(m.code,'') IN ('operations','operations.tasks','operations.chat','knowledge','knowledge.articles','knowledge.assistant')
ON CONFLICT(role_key,menu_id) DO NOTHING;

INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,scope_type)
SELECT 'receptionist',m.id,true,true,true,'own_location'
FROM menus m
WHERE COALESCE(m.code,'') IN (
  'operations','operations.tasks','operations.chat','operations.mail',
  'knowledge','knowledge.articles','knowledge.assistant',
  'marketing','marketing.complaints','marketing.feedback',
  'finance','finance.transactions','finance.cash','finance.payments','finance.guest_accounts'
)
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- ============================================================
-- ÉLETSZERŰ DEMÓ ADATOK – minden rekord jól felismerhetően DEMO
-- ============================================================

WITH demo(module_key,title,description,status,priority,amount,due_at,data) AS (
  VALUES
    ('operations.tasks','DEMO – Nyitás előtti higiéniai ellenőrzés','Recepció, kezelők és vendégtér ellenőrzőlista.','open','high',NULL,now()+interval '1 day','{"shift":"morning","department":"Recepció","approval_required":true}'::jsonb),
    ('operations.tasks','DEMO – Heti készletszint ellenőrzés','A kiemelt kozmetikai fogyóanyagok tételes ellenőrzése.','in_progress','normal',NULL,now()+interval '3 days','{"recurrence":"weekly","inventory_check":true}'::jsonb),
    ('operations.complaints','DEMO – Várakozási idő kivizsgálása','A vendég a tervezettnél húsz perccel később került sorra.','investigating','high',NULL,now()+interval '2 days','{"subject":"Várakozás miatt","channel":"email","guest_notified":false}'::jsonb),
    ('hr.job-postings','DEMO – Kozmetikus, Budapest','Tapasztalt kozmetikus kollégát keresünk teljes munkaidőben.','published','normal',NULL,now()+interval '30 days','{"employment_type":"Teljes munkaidő","public":true}'::jsonb),
    ('hr.applications','DEMO – Minta Emese jelentkezése','Beérkezett önéletrajz és kérdőív.','interview','normal',NULL,now()+interval '5 days','{"email":"minta.emese@example.com","phone":"+36 30 555 0101","position":"Kozmetikus"}'::jsonb),
    ('marketing.newsletters','DEMO – Őszi bőrápolási kampány','Szegmentált hírlevél a kozmetikai vendégeknek.','draft','normal',NULL,now()+interval '7 days','{"segment":"Kozmetika – aktív vendégek","provider":"not_configured"}'::jsonb),
    ('marketing.daily-deals','DEMO – Délutáni arckezelés akció','Szabad kapacitás feltöltése 13:00–16:00 között.','scheduled','normal',20,now()+interval '1 day','{"discount_type":"percent","department":"Kozmetika"}'::jsonb),
    ('marketing.reviews','DEMO – 5 csillagos vendégértékelés','Kedves és pontos kiszolgálás.','pending_moderation','normal',5,NULL,'{"source":"kiosk","employee_related":true,"publish_to_facebook":false}'::jsonb),
    ('finance.transactions','DEMO – Napi bankkártyás bevétel','Teszt pénzügyi tranzakció.','posted','normal',186500,NULL,'{"direction":"income","payment_method":"Bankkártya"}'::jsonb),
    ('finance.incoming-invoices','DEMO – Kozmetikai anyagbeszerzés','Beszállítói számla teszteléshez.','pending','normal',94200,now()+interval '8 days','{"invoice_number":"DEMO-BEJ-2026-001","supplier":"DEMO Beauty Partner Kft.","currency":"HUF"}'::jsonb),
    ('finance.cash-control','DEMO – Reggeli pénztárnyitás','Nyitó készpénzállomány ellenőrzése.','open','normal',50000,NULL,'{"operation":"open","difference":0}'::jsonb),
    ('inventory.orders','DEMO – Központi fogyóanyag-rendelés','Kozmetikai kesztyűk és fertőtlenítő rendelése.','submitted','normal',NULL,now()+interval '4 days','{"supplier":"DEMO Beauty Partner Kft.","items":8}'::jsonb),
    ('inventory.receipts','DEMO – Augusztusi bevételezés','Központból érkezett termékek átvétele.','received','normal',128400,NULL,'{"items":12,"warehouse":"Szalon raktár"}'::jsonb),
    ('inventory.transfers','DEMO – Eger → Budapest átadás','Professzionális hajápoló termékek átadása.','in_transit','normal',NULL,now()+interval '2 days','{"source":"Eger","destination":"Budapest","items":6}'::jsonb),
    ('inventory.adjustments','DEMO – Havi leltárkorrekció','Két tétel készleteltérésének dokumentálása.','approved','normal',-6400,NULL,'{"reason":"inventory_difference","items":2}'::jsonb),
    ('inventory.salon-usage','DEMO – Kabin napi anyagfelhasználás','Arckezelésekhez felhasznált professzionális anyagok.','posted','normal',7800,NULL,'{"department":"Kozmetika","items":5}'::jsonb),
    ('reports.report-editor','DEMO – Havi szalonvezetői riport','Forgalom, kapacitás, hiányzás és készlet egy jelentésben.','active','normal',NULL,NULL,'{"format":["pdf","xlsx"],"schedule":"monthly"}'::jsonb),
    ('master.departments','DEMO – Kozmetika','Kozmetikai kezelések és bőrápolás.','active','normal',NULL,NULL,'{"code":"KOZMETIKA","sort_order":20}'::jsonb),
    ('master.payment-methods','DEMO – Bankkártya','Bankkártyás fizetési mód.','active','normal',NULL,NULL,'{"code":"CARD","requires_reference":true}'::jsonb),
    ('settings.application','DEMO – Alap folyamatbeállítások','Online kedvezmény és szervizfigyelmeztetés.','active','normal',NULL,NULL,'{"online_booking_discount_percent":5,"asset_service_warning_days":14,"idle_logout_minutes":5}'::jsonb)
)
INSERT INTO vir_module_records(module_key,title,description,status,priority,location_id,amount,due_at,data,created_by)
SELECT d.module_key,d.title,d.description,d.status,d.priority,l.id,d.amount,d.due_at,d.data,'demo-seed'
FROM demo d
LEFT JOIN LATERAL (SELECT id FROM locations ORDER BY name LIMIT 1) l ON true
WHERE NOT EXISTS (
  SELECT 1 FROM vir_module_records r WHERE r.module_key=d.module_key AND r.title=d.title
);

INSERT INTO vir_knowledge_articles(title,slug,summary,content,category,tags,status,visibility,created_by)
SELECT * FROM (VALUES
  ('Vendég fogadása és időpont ellenőrzése','vendeg-fogadasa','A recepciós nyitó folyamata.','Azonosítsd a vendéget név és elérhetőség alapján, ellenőrizd az időpontot, a szolgáltatást és a munkatársat. Eltérés esetén még a munkalap megnyitása előtt pontosítsd az adatokat.','Ügyfélkezelés',ARRAY['vendég','recepció','időpont'],'published','internal','demo-seed'),
  ('Munkalap lezárása','munkalap-lezarasa','Szolgáltatás, termék és fizetés ellenőrzése.','Lezárás előtt ellenőrizd az elvégzett szolgáltatásokat, a felhasznált vagy értékesített termékeket, a kedvezmény jogcímét és a fizetési módot. Nyitott vendéggel a nap nem zárható le.','Munkalap',ARRAY['munkalap','fizetés'],'published','internal','demo-seed'),
  ('Panaszkezelési folyamat','panaszkezeles','Panasz rögzítése, kivizsgálása és visszajelzés.','Rögzítsd a vendéget, a panasz tárgyát, csatornáját, érintett munkatársát és minden melléklet hivatkozását. A kivizsgálás eredményét és a vendég tájékoztatását is dokumentálni kell.','Minőség',ARRAY['panasz','minőség'],'published','internal','demo-seed'),
  ('Pénztár nyitás és zárás','penztar-nyitas-zaras','A készpénzállomány biztonságos kezelése.','Nyitáskor rögzítsd a nyitó készletet. Záráskor egyeztesd a rendszer szerinti és tényleges összeget, dokumentáld az eltérést, majd vezetői jogosultsággal hagyd jóvá a zárást.','Pénzügy',ARRAY['pénztár','zárás'],'published','internal','demo-seed'),
  ('Raktárközi átadás','raktarkozi-atadas','Átadás indítása, szállítás és átvétel.','Az átadó raktár rögzíti a termékeket és mennyiségeket, a fogadó raktár pedig tételesen átveszi azokat. Eltérésnél korrekció és indoklás szükséges.','Logisztika',ARRAY['raktár','készlet','átadás'],'published','internal','demo-seed'),
  ('Munkaidő és jelenlét','munkaido-jelenlet','Munkaidő indítása, befejezése és jóváhagyása.','A munkatárs a műszak kezdetén indítja, a végén lezárja a munkaidőt. A szünetet, túlórát és eltéréseket rögzíteni kell; a vezető a jelenléti ívet jóváhagyja.','HR',ARRAY['munkaidő','jelenlét'],'published','internal','demo-seed')
) v(title,slug,summary,content,category,tags,status,visibility,created_by)
WHERE NOT EXISTS (SELECT 1 FROM vir_knowledge_articles a WHERE a.slug=v.slug);

INSERT INTO vir_settings(setting_key,location_id,value,description,updated_by)
SELECT 'application.defaults',NULL,
       '{"online_booking_discount_percent":5,"asset_service_warning_days":14,"idle_logout_minutes":5,"languages":["hu","en"],"soft_delete":true}'::jsonb,
       'A specifikációban előírt alapértelmezett alkalmazásbeállítások','migration'
WHERE NOT EXISTS (
  SELECT 1 FROM vir_settings WHERE setting_key='application.defaults' AND location_id IS NULL
);

INSERT INTO schema_migrations(version,description)
VALUES('20260806_VIR_SPEC_ALIGNMENT_V1','VIR specifikációs modulregiszter, tudásbázis, AI chat, menük és demo adatok')
ON CONFLICT(version) DO NOTHING;

COMMIT;
