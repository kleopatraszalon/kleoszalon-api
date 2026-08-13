BEGIN;

-- KLEOSZALON VIR – TÖRZSADATOK TELJES SPECIFIKÁCIÓS MENÜ (3.1–3.22)
-- A már működő domain-oldalakat újrahasznosítjuk; csak a valóban hiányzó
-- törzseket szolgálja ki a generikus VIR CRUD.

INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES('masterdata','Törzsadatok','Database',NULL,145,NULL,'master_data',true)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,icon=EXCLUDED.icon,route=NULL,order_index=EXCLUDED.order_index,
  parent_id=NULL,feature_key=EXCLUDED.feature_key,is_active=true;

WITH parent AS (
  SELECT id FROM menus WHERE code='masterdata' LIMIT 1
), items(code,name,icon,route,order_index,feature_key) AS (
  VALUES
    ('masterdata.user-groups','Felhasználói csoportok','ShieldCheck','/admin/access-control',10,'access_control'),
    ('masterdata.users','Felhasználók','Users','/employees',20,'hr'),
    ('masterdata.service-types','Szolgáltatás típusok','Tags','/masterdata/services?view=categories',30,'service_categories'),
    ('masterdata.services','Szolgáltatások','Sparkles','/masterdata/services',40,'services'),
    ('masterdata.product-types','Termék típusok','Tags','/masterdata/products/taxonomy-review',50,'product_types'),
    ('masterdata.products','Termékek','Package','/masterdata/products',60,'products'),
    ('masterdata.equipment-types','Eszköz típusok','Settings2','/masterdata/equipment-types',70,'assets'),
    ('masterdata.assets','Eszközök','Wrench','/masterdata/assets',80,'assets'),
    ('masterdata.positions','Munkakörök','BriefcaseBusiness','/hr/positions',90,'hr_positions'),
    ('masterdata.departments','Részlegek','Building2','/masterdata/departments',100,'departments'),
    ('masterdata.leave-types','Szabadság típusok','CalendarDays','/masterdata/leave-types',110,'leave_types'),
    ('masterdata.discounts','Kedvezménytörzs','BadgePercent','/spec/discounts',120,'discounts'),
    ('masterdata.payment-methods','Fizetési módok','WalletCards','/masterdata/payment-methods',130,'finance'),
    ('masterdata.tax-rates','ÁFA típusok','Percent','/spec/vat-types',140,'vat_types'),
    ('masterdata.salons','Telephelyek','MapPin','/masterdata/salons',150,'master_data'),
    ('masterdata.price-types','Ár típusok','Landmark','/masterdata/price-types',160,'price_types'),
    ('masterdata.warehouses','Raktárak','Warehouse','/masterdata/warehouses',170,'warehouses'),
    ('masterdata.units','Mértékegységek','Ruler','/masterdata/units',180,'units'),
    ('masterdata.guest-accounts','Vendégszámlák','CreditCard','/spec/guest-accounts',190,'guest_accounts'),
    ('masterdata.passes-giftcards','Bérletek és ajándékkártyák','Gift','/loyalty',200,'loyalty'),
    ('masterdata.guest-account-types','Vendégszámla tranzakció típusok','ReceiptText','/spec/guest-account-transaction-types',210,'guest_account_transaction_types'),
    ('masterdata.user-fields','Felhasználói mezők','ListPlus','/spec/user-fields',220,'user_fields')
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT i.code,i.name,i.icon,i.route,i.order_index,p.id,i.feature_key,true
FROM items i CROSS JOIN parent p
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,icon=EXCLUDED.icon,route=EXCLUDED.route,order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;

-- A meglévő, hasznos extra törzsadatok megmaradnak a specifikációs 22-es blokk után.
UPDATE menus SET order_index=230,parent_id=(SELECT id FROM menus WHERE code='masterdata' LIMIT 1),is_active=true
 WHERE code='masterdata.suppliers';
UPDATE menus SET order_index=240,parent_id=(SELECT id FROM menus WHERE code='masterdata' LIMIT 1),is_active=true
 WHERE code='masterdata.movement-types';
UPDATE menus SET order_index=250,parent_id=(SELECT id FROM menus WHERE code='masterdata' LIMIT 1),is_active=true
 WHERE code='masterdata.transaction-types';
UPDATE menus SET order_index=52,parent_id=(SELECT id FROM menus WHERE code='masterdata' LIMIT 1),is_active=true
 WHERE code='masterdata.product-groups';
UPDATE menus SET order_index=54,parent_id=(SELECT id FROM menus WHERE code='masterdata' LIMIT 1),is_active=true
 WHERE code='masterdata.product-categories';
UPDATE menus SET order_index=45,parent_id=(SELECT id FROM menus WHERE code='masterdata' LIMIT 1),is_active=true
 WHERE code='masterdata.employee-services';

-- A három olyan specifikációs törzs, amelyhez jelenleg nincs külön domain-kezelő,
-- valódi generikus CRUD definíciót kap a meglévő VIR rekordmotoron.
INSERT INTO vir_module_definitions
(module_key,title,category,route,description,entity_label,icon,fields,statuses,spec_reference,order_index,is_active)
VALUES
('vat-types','ÁFA típusok','Törzsadatok','/spec/vat-types',
 'A termékeknél, szolgáltatásoknál és számlázásnál választható ÁFA-kulcsok központi törzse.',
 'ÁFA típus','Percent',
 '[{"key":"code","label":"Kód","type":"text","required":true},{"key":"name","label":"Megnevezés","type":"text","required":true},{"key":"rate_percent","label":"ÁFA mértéke (%)","type":"number","required":true},{"key":"nav_code","label":"NAV kód","type":"text"},{"key":"description","label":"Megjegyzés","type":"textarea"}]'::jsonb,
 '["active","inactive","archived"]'::jsonb,'Spec. 3.14. ÁFA típusok',140,true),
('guest-accounts','Vendégszámlák','Törzsadatok','/spec/guest-accounts',
 'A vendégek belső egyenlegének, előlegének és felhasználható keretének adminisztrációs törzse.',
 'vendégszámla','CreditCard',
 '[{"key":"name","label":"Megnevezés","type":"text","required":true},{"key":"account_type","label":"Típus","type":"select","required":true,"options":["egyenleg","előleg","jóváírás","egyéb"]},{"key":"currency","label":"Pénznem","type":"text"},{"key":"allow_negative","label":"Negatív egyenleg engedélyezett","type":"boolean"},{"key":"description","label":"Megjegyzés","type":"textarea"}]'::jsonb,
 '["active","inactive","archived"]'::jsonb,'Spec. 3.19. Vendégszámlák',190,true),
('user-fields','Felhasználói mezők','Törzsadatok','/spec/user-fields',
 'Adminisztrátor által létrehozható egyedi mezők a VIR adatlapjaihoz, típus- és kötelezőség-beállítással.',
 'felhasználói mező','ListPlus',
 '[{"key":"code","label":"Mezőkód","type":"text","required":true},{"key":"name","label":"Megnevezés","type":"text","required":true},{"key":"target_entity","label":"Adatlap / célobjektum","type":"text","required":true},{"key":"field_type","label":"Mező típusa","type":"select","required":true,"options":["szöveg","szám","dátum","igen/nem","lista"]},{"key":"required","label":"Kötelező","type":"boolean"},{"key":"options","label":"Lista értékei","type":"textarea"},{"key":"sort_order","label":"Sorrend","type":"number"}]'::jsonb,
 '["active","inactive","archived"]'::jsonb,'Spec. 3.22. Felhasználói mezők',220,true)
ON CONFLICT(module_key) DO UPDATE SET
 title=EXCLUDED.title,category=EXCLUDED.category,route=EXCLUDED.route,description=EXCLUDED.description,
 entity_label=EXCLUDED.entity_label,icon=EXCLUDED.icon,fields=EXCLUDED.fields,statuses=EXCLUDED.statuses,
 spec_reference=EXCLUDED.spec_reference,order_index=EXCLUDED.order_index,is_active=true,updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260813_MASTERDATA_SPEC_COMPLETE_V3','Törzsadatok 3.1–3.22 teljes menü és hiányzó generikus CRUD definíciók')
ON CONFLICT(version) DO NOTHING;

COMMIT;
