BEGIN;

-- A specifikációban szereplő, de korábban placeholder/stale útvonalra mutató
-- törzsadat menük élő kezelőfelületre kerülnek.
UPDATE menus SET name='Felhasználói csoportok',route='/admin/access-control',feature_key='access_control',is_active=true
 WHERE code='masterdata.user-groups';
UPDATE menus SET name='Felhasználók',route='/employees',feature_key='hr',is_active=true
 WHERE code='masterdata.users';
UPDATE menus SET name='Kedvezménytörzs',route='/spec/discounts',feature_key='discounts',is_active=true
 WHERE code='masterdata.discounts';
UPDATE menus SET name='Raktárak',route='/masterdata/warehouses',feature_key='warehouses',is_active=true
 WHERE code='masterdata.warehouses';
UPDATE menus SET name='Vendégszámla-tranzakciótípusok',route='/spec/guest-account-transaction-types',feature_key='guest_account_transaction_types',is_active=true
 WHERE code IN('masterdata.guest-account-types','masterdata.guest-account-transaction-types');

-- Ha valamelyik régi adatbázisban hiányzik a menürekord, idempotensen létrehozzuk.
WITH parent AS (SELECT id FROM menus WHERE code='masterdata' LIMIT 1), items(code,name,route,order_index,feature_key) AS (
 VALUES
 ('masterdata.user-groups','Felhasználói csoportok','/admin/access-control',10,'access_control'),
 ('masterdata.users','Felhasználók','/employees',20,'hr'),
 ('masterdata.discounts','Kedvezménytörzs','/spec/discounts',70,'discounts'),
 ('masterdata.warehouses','Raktárak','/masterdata/warehouses',110,'warehouses'),
 ('masterdata.guest-account-types','Vendégszámla-tranzakciótípusok','/spec/guest-account-transaction-types',140,'guest_account_transaction_types')
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT i.code,i.name,NULL,i.route,i.order_index,p.id,i.feature_key,true FROM items i CROSS JOIN parent p
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;

-- Kedvezménytörzs: a PDF 3.12 szerint időintervallum, százalék/Ft típus,
-- valamint szolgáltatás- és termékoldali érték/célzás kezelhető.
INSERT INTO vir_module_definitions
(module_key,title,category,route,description,entity_label,icon,fields,statuses,spec_reference,order_index,is_active)
VALUES
('discounts','Kedvezménytörzs','Törzsadatok','/spec/discounts',
 'Vendégadatlapon és munkalapon választható kedvezmények; félórás idősávval, százalékos vagy fix összegű értékkel, szolgáltatásra és termékre külön célzással.',
 'kedvezmény','BadgePercent',
 '[{"key":"discount_type","label":"Típus","type":"select","required":true,"options":["százalék","fix összeg (Ft)"]},{"key":"service_value","label":"Szolgáltatás kedvezménye","type":"number"},{"key":"product_value","label":"Termék / eszköz kedvezménye","type":"number"},{"key":"service_category","label":"Szolgáltatás kategória","type":"text"},{"key":"product_type","label":"Terméktípus","type":"text"},{"key":"valid_from","label":"Érvényesség kezdete","type":"date"},{"key":"valid_until","label":"Érvényesség vége","type":"date"},{"key":"weekdays","label":"Érvényes napok","type":"text"},{"key":"time_from","label":"Idősáv kezdete (HH:MM)","type":"text"},{"key":"time_to","label":"Idősáv vége (HH:MM)","type":"text"}]'::jsonb,
 '["active","inactive","archived"]'::jsonb,'Spec. 3.12. Kedvezmények',70,true),
('guest-account-transaction-types','Vendégszámla-tranzakciótípusok','Törzsadatok','/spec/guest-account-transaction-types',
 'A vendégszámla tranzakcióknál választható típustörzs (például feltöltés), a hozzá tartozó pénzügyi tranzakciótípussal.',
 'vendégszámla-tranzakciótípus','ReceiptText',
 '[{"key":"code","label":"Kód","type":"text","required":true},{"key":"financial_transaction_type","label":"Pénzügyi tranzakciótípus","type":"text","required":true},{"key":"description","label":"Leírás","type":"textarea"}]'::jsonb,
 '["active","inactive","archived"]'::jsonb,'Spec. 3.21. Vendég számla tranzakciók',140,true)
ON CONFLICT(module_key) DO UPDATE SET
 title=EXCLUDED.title,category=EXCLUDED.category,route=EXCLUDED.route,description=EXCLUDED.description,
 entity_label=EXCLUDED.entity_label,icon=EXCLUDED.icon,fields=EXCLUDED.fields,statuses=EXCLUDED.statuses,
 spec_reference=EXCLUDED.spec_reference,order_index=EXCLUDED.order_index,is_active=true,updated_at=now();

-- A vezetői/admin felületek számára a menük biztosan láthatók; felhasználói csoportok
-- és felhasználók tényleges írási jogosultságát továbbra is az Access Control/HR modul őrzi.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT r.role_key,m.id,true,
 CASE WHEN m.code IN('masterdata.discounts','masterdata.guest-account-types','masterdata.warehouses') THEN true ELSE false END,
 CASE WHEN m.code IN('masterdata.discounts','masterdata.guest-account-types','masterdata.warehouses') THEN true ELSE false END,
 false,false,true,
 CASE WHEN m.code='masterdata.guest-account-types' THEN true ELSE false END,
 CASE WHEN r.role_key='admin' AND m.code='masterdata.user-groups' THEN true ELSE false END,
 'all_locations',now()
FROM (VALUES('admin'),('manager')) r(role_key)
JOIN menus m ON m.code IN('masterdata.user-groups','masterdata.users','masterdata.discounts','masterdata.warehouses','masterdata.guest-account-types')
ON CONFLICT(role_key,menu_id) DO UPDATE SET
 can_view=true,can_create=EXCLUDED.can_create,can_edit=EXCLUDED.can_edit,can_export=true,
 can_view_financial=EXCLUDED.can_view_financial,can_manage_permissions=EXCLUDED.can_manage_permissions,
 scope_type='all_locations',updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260813_MASTERDATA_LIVE_MENUS_V2','Hiányzó törzsadat menük élő útvonalai és PDF-alapú Kedvezmény/Vendégszámla-típus modulok')
ON CONFLICT(version) DO NOTHING;

COMMIT;
