BEGIN;

-- ============================================================
-- KLEOSZALON BESZERZÉS – TESZTADATOK
-- Cél: a Beszerzési dashboard és minden almenü kipróbálható legyen.
-- A script meglévő termékeket használ, de csak olyanokat, amelyekhez még
-- nincs KÖZPONTI (location_id IS NULL) készletegyenleg, így meglévő készletet
-- nem ír felül. Minden létrehozott üzleti rekord [TESZT] jelölést kap.
-- Idempotens: újrafuttatás előtt a saját korábbi tesztrendeléseit törli.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.product_stock_balances') IS NULL
     OR to_regclass('public.suppliers') IS NULL
     OR to_regclass('public.product_supplier_terms') IS NULL
     OR to_regclass('public.purchase_orders') IS NULL
     OR to_regclass('public.purchase_order_items') IS NULL
     OR to_regclass('public.procurement_approval_settings') IS NULL THEN
    RAISE EXCEPTION 'A beszerzési séma hiányos. Előbb futtasd a 20260807_PROCUREMENT_SCHEMA_REPAIR_V2.sql migrációt.';
  END IF;
END $$;

-- Korábbi, ezzel a seeddel létrehozott rendeléseket eltávolítjuk.
DELETE FROM purchase_orders
WHERE note LIKE '[TESZT BESZERZÉS]%';

-- Korábbi teszt beszállítói kapcsolatok törlése csak a teszt beszállítókhoz.
DELETE FROM product_supplier_terms pst
USING suppliers s
WHERE pst.supplier_id = s.id
  AND s.name LIKE '[TESZT] %';

-- Teszt beszállítók.
INSERT INTO suppliers
  (name, tax_number, email, phone, contact_name, address, website,
   payment_terms_days, default_lead_time_days, active, note, updated_at)
VALUES
  ('[TESZT] BeautyPro Hungary', 'TEST-11111111-1-11', 'rendeles@beautypro.test', '+36 1 555 0101', 'Nagy Júlia', '1111 Budapest, Teszt utca 1.', 'https://example.test/beautypro', 15, 2, true, '[TESZT BESZERZÉS] gyors, preferált beszállító', now()),
  ('[TESZT] Salon Supply Kft.', 'TEST-22222222-2-22', 'sales@salonsupply.test', '+36 1 555 0202', 'Kiss Márton', '2222 Budapest, Próba tér 2.', 'https://example.test/salonsupply', 30, 5, true, '[TESZT BESZERZÉS] kedvezőbb ár, hosszabb lead time', now()),
  ('[TESZT] ProCosmetic Trade', 'TEST-33333333-3-33', 'order@procosmetic.test', '+36 1 555 0303', 'Tóth Anna', '3333 Budapest, Minta köz 3.', 'https://example.test/procosmetic', 8, 1, true, '[TESZT BESZERZÉS] sürgős rendeléshez', now())
ON CONFLICT (name) DO UPDATE SET
  email = EXCLUDED.email,
  phone = EXCLUDED.phone,
  contact_name = EXCLUDED.contact_name,
  payment_terms_days = EXCLUDED.payment_terms_days,
  default_lead_time_days = EXCLUDED.default_lead_time_days,
  active = true,
  note = EXCLUDED.note,
  updated_at = now();

-- Legalább 8 olyan aktív terméket választunk, amelynek nincs központi készletsora.
CREATE TEMP TABLE _proc_test_products ON COMMIT DROP AS
SELECT p.id, p.name,
       row_number() OVER (ORDER BY p.name, p.id) AS rn
FROM products p
WHERE COALESCE(p.is_active, true) = true
  AND NOT EXISTS (
    SELECT 1
    FROM product_stock_balances b
    WHERE b.product_id = p.id
      AND b.location_id IS NULL
  )
ORDER BY p.name, p.id
LIMIT 8;

DO $$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM _proc_test_products;
  IF v_count < 8 THEN
    RAISE EXCEPTION 'A teszteléshez 8 olyan aktív termék szükséges, amelyhez még nincs központi készletsor. Jelenleg csak % található.', v_count;
  END IF;
END $$;

-- Készletállapotok: normál / minimum alatti / kifogyott / alacsony.
INSERT INTO product_stock_balances
  (product_id, location_id, quantity, min_quantity, unit_cost, updated_at)
SELECT id, NULL,
       CASE rn
         WHEN 1 THEN 18 WHEN 2 THEN 3 WHEN 3 THEN 0 WHEN 4 THEN 4
         WHEN 5 THEN 22 WHEN 6 THEN 2 WHEN 7 THEN 1 ELSE 14 END::numeric,
       CASE rn
         WHEN 1 THEN 8 WHEN 2 THEN 8 WHEN 3 THEN 6 WHEN 4 THEN 10
         WHEN 5 THEN 8 WHEN 6 THEN 6 WHEN 7 THEN 5 ELSE 7 END::numeric,
       CASE rn
         WHEN 1 THEN 3200 WHEN 2 THEN 4750 WHEN 3 THEN 6800 WHEN 4 THEN 2450
         WHEN 5 THEN 8900 WHEN 6 THEN 3600 WHEN 7 THEN 5200 ELSE 4100 END::numeric,
       now()
FROM _proc_test_products;

-- Készletmozgási előzmény is legyen látható.
INSERT INTO inventory_movements
  (product_id, location_id, movement_type, quantity, balance_after,
   unit_cost, stock_value_after, note, created_by, created_at)
SELECT b.product_id, NULL, 'opening', b.quantity, b.quantity,
       b.unit_cost, b.quantity * b.unit_cost,
       '[TESZT BESZERZÉS] nyitó tesztkészlet', 'demo-seed', now() - interval '20 days'
FROM product_stock_balances b
JOIN _proc_test_products tp ON tp.id = b.product_id
WHERE b.location_id IS NULL;

-- Beszállítói kondíciók. Ugyanahhoz a termékhez több beszállító is tartozhat.
WITH s AS (
  SELECT
    max(id) FILTER (WHERE name='[TESZT] BeautyPro Hungary') AS beauty,
    max(id) FILTER (WHERE name='[TESZT] Salon Supply Kft.') AS salon,
    max(id) FILTER (WHERE name='[TESZT] ProCosmetic Trade') AS pro
  FROM suppliers
)
INSERT INTO product_supplier_terms
  (product_id, supplier_id, supplier_product_code, unit_price,
   minimum_order_quantity, lead_time_days, preferred, active, note, updated_at)
SELECT tp.id,
       CASE WHEN tp.rn IN (1,2,3,4) THEN s.beauty
            WHEN tp.rn IN (5,6) THEN s.salon ELSE s.pro END,
       'TEST-' || lpad(tp.rn::text, 3, '0'),
       CASE tp.rn
         WHEN 1 THEN 3100 WHEN 2 THEN 4500 WHEN 3 THEN 6500 WHEN 4 THEN 2300
         WHEN 5 THEN 8500 WHEN 6 THEN 3400 WHEN 7 THEN 5000 ELSE 3950 END,
       CASE tp.rn WHEN 2 THEN 12 WHEN 3 THEN 6 WHEN 4 THEN 10 WHEN 6 THEN 8 ELSE 4 END,
       CASE WHEN tp.rn IN (1,2,3,4) THEN 2 WHEN tp.rn IN (5,6) THEN 5 ELSE 1 END,
       true, true, '[TESZT BESZERZÉS] elsődleges kondíció', now()
FROM _proc_test_products tp CROSS JOIN s;

-- Alternatív árak az első 4 termékhez, hogy a több-beszállítós rangsorolás tesztelhető legyen.
WITH s AS (
  SELECT max(id) FILTER (WHERE name='[TESZT] Salon Supply Kft.') AS salon
  FROM suppliers
)
INSERT INTO product_supplier_terms
  (product_id, supplier_id, supplier_product_code, unit_price,
   minimum_order_quantity, lead_time_days, preferred, active, note, updated_at)
SELECT tp.id, s.salon, 'ALT-' || lpad(tp.rn::text,3,'0'),
       CASE tp.rn WHEN 1 THEN 2950 WHEN 2 THEN 4350 WHEN 3 THEN 6300 ELSE 2200 END,
       6, 5, false, true, '[TESZT BESZERZÉS] alternatív, olcsóbb beszállító', now()
FROM _proc_test_products tp CROSS JOIN s
WHERE tp.rn <= 4;

-- ============================================================
-- TESZT RENDELÉSEK
-- 1) vezetői jóváhagyásra vár
-- 2) késedelmes megrendelt
-- 3) részben beérkezett + jelentős áreltérés
-- 4) teljesített, határidőre érkezett
-- ============================================================

WITH s AS (SELECT id FROM suppliers WHERE name='[TESZT] BeautyPro Hungary')
INSERT INTO purchase_orders
  (location_id, supplier_name, supplier_id, status, expected_at, note,
   created_by, updated_by, created_at, updated_at,
   approval_status, approval_requested_at, approval_requested_by)
SELECT NULL, '[TESZT] BeautyPro Hungary', s.id, 'draft', current_date + 3,
       '[TESZT BESZERZÉS] 01 - vezetői jóváhagyásra vár',
       'demo-seed', 'demo-seed', now()-interval '1 day', now(),
       'pending', now()-interval '20 hours', 'demo.manager@test.local'
FROM s;

WITH o AS (
  SELECT id FROM purchase_orders WHERE note='[TESZT BESZERZÉS] 01 - vezetői jóváhagyásra vár' ORDER BY id DESC LIMIT 1
)
INSERT INTO purchase_order_items
  (purchase_order_id, product_id, ordered_quantity, received_quantity, unit_cost, note)
SELECT o.id, tp.id,
       CASE tp.rn WHEN 2 THEN 12 ELSE 8 END,
       0,
       CASE tp.rn WHEN 2 THEN 4500 ELSE 6500 END,
       '[TESZT BESZERZÉS] jóváhagyási tétel'
FROM o CROSS JOIN _proc_test_products tp
WHERE tp.rn IN (2,3);

WITH s AS (SELECT id FROM suppliers WHERE name='[TESZT] Salon Supply Kft.')
INSERT INTO purchase_orders
  (location_id, supplier_name, supplier_id, status, expected_at, note,
   created_by, updated_by, ordered_at, created_at, updated_at,
   approval_status, approved_at, approved_by, approved_total)
SELECT NULL, '[TESZT] Salon Supply Kft.', s.id, 'ordered', current_date - 5,
       '[TESZT BESZERZÉS] 02 - késedelmes rendelés',
       'demo-seed', 'demo-seed', now()-interval '10 days', now()-interval '11 days', now(),
       'approved', now()-interval '10 days', 'vezető@test.local', 87000
FROM s;

WITH o AS (
  SELECT id FROM purchase_orders WHERE note='[TESZT BESZERZÉS] 02 - késedelmes rendelés' ORDER BY id DESC LIMIT 1
)
INSERT INTO purchase_order_items
  (purchase_order_id, product_id, ordered_quantity, received_quantity, unit_cost, note)
SELECT o.id, tp.id, 10, 0,
       CASE tp.rn WHEN 4 THEN 2200 ELSE 6500 END,
       '[TESZT BESZERZÉS] késedelmes tétel'
FROM o CROSS JOIN _proc_test_products tp
WHERE tp.rn IN (3,4);

WITH s AS (SELECT id FROM suppliers WHERE name='[TESZT] ProCosmetic Trade')
INSERT INTO purchase_orders
  (location_id, supplier_name, supplier_id, status, expected_at, note,
   created_by, updated_by, ordered_at, created_at, updated_at,
   approval_status, approved_at, approved_by, approved_total)
SELECT NULL, '[TESZT] ProCosmetic Trade', s.id, 'partially_received', current_date - 2,
       '[TESZT BESZERZÉS] 03 - részben beérkezett, áreltéréssel',
       'demo-seed', 'demo-seed', now()-interval '8 days', now()-interval '9 days', now(),
       'auto_approved', now()-interval '8 days', 'system', 72000
FROM s;

WITH o AS (
  SELECT id FROM purchase_orders WHERE note='[TESZT BESZERZÉS] 03 - részben beérkezett, áreltéréssel' ORDER BY id DESC LIMIT 1
)
INSERT INTO purchase_order_items
  (purchase_order_id, product_id, ordered_quantity, received_quantity, unit_cost, actual_unit_cost, note)
SELECT o.id, tp.id,
       CASE tp.rn WHEN 6 THEN 8 ELSE 6 END,
       CASE tp.rn WHEN 6 THEN 4 ELSE 3 END,
       CASE tp.rn WHEN 6 THEN 3400 ELSE 5000 END,
       CASE tp.rn WHEN 6 THEN 4100 ELSE 5850 END,
       '[TESZT BESZERZÉS] részbevétel + >10% áreltérés'
FROM o CROSS JOIN _proc_test_products tp
WHERE tp.rn IN (6,7);

WITH s AS (SELECT id FROM suppliers WHERE name='[TESZT] BeautyPro Hungary')
INSERT INTO purchase_orders
  (location_id, supplier_name, supplier_id, status, expected_at, note,
   created_by, updated_by, ordered_at, received_at, created_at, updated_at,
   approval_status, approved_at, approved_by, approved_total)
SELECT NULL, '[TESZT] BeautyPro Hungary', s.id, 'received', current_date - 10,
       '[TESZT BESZERZÉS] 04 - határidőre teljesített',
       'demo-seed', 'demo-seed', now()-interval '15 days', now()-interval '11 days', now()-interval '16 days', now(),
       'auto_approved', now()-interval '15 days', 'system', 49600
FROM s;

WITH o AS (
  SELECT id FROM purchase_orders WHERE note='[TESZT BESZERZÉS] 04 - határidőre teljesített' ORDER BY id DESC LIMIT 1
)
INSERT INTO purchase_order_items
  (purchase_order_id, product_id, ordered_quantity, received_quantity, unit_cost, actual_unit_cost, note)
SELECT o.id, tp.id, 8, 8, 3100, 3190,
       '[TESZT BESZERZÉS] teljesített tétel'
FROM o CROSS JOIN _proc_test_products tp
WHERE tp.rn = 1;

-- Jóváhagyási események a dashboard teszteléséhez.
INSERT INTO procurement_approval_events
  (purchase_order_id, event_type, actor_key, note, order_total, created_at)
SELECT po.id,
       CASE po.approval_status
         WHEN 'pending' THEN 'requested'
         WHEN 'approved' THEN 'approved'
         ELSE 'auto_approved'
       END,
       'demo-seed', '[TESZT BESZERZÉS] generált workflow esemény',
       COALESCE((SELECT sum(i.ordered_quantity*i.unit_cost) FROM purchase_order_items i WHERE i.purchase_order_id=po.id),0),
       po.created_at + interval '2 hours'
FROM purchase_orders po
WHERE po.note LIKE '[TESZT BESZERZÉS]%';

UPDATE procurement_approval_settings
SET approval_threshold = 50000,
    price_variance_warning_pct = 10,
    updated_by = 'demo-seed',
    updated_at = now()
WHERE id = 1;

COMMIT;

-- ============================================================
-- ELLENŐRZÉS
-- ============================================================
-- SELECT count(*) AS teszt_keszletsor
-- FROM product_stock_balances b
-- JOIN products p ON p.id=b.product_id
-- WHERE b.location_id IS NULL
--   AND EXISTS (SELECT 1 FROM inventory_movements m WHERE m.product_id=b.product_id AND m.note='[TESZT BESZERZÉS] nyitó tesztkészlet');
--
-- SELECT id,name,default_lead_time_days FROM suppliers WHERE name LIKE '[TESZT] %' ORDER BY id;
-- SELECT id,supplier_name,status,approval_status,expected_at,note FROM purchase_orders WHERE note LIKE '[TESZT BESZERZÉS]%' ORDER BY id;
--
-- ============================================================
-- TESZTADATOK KÉSŐBBI TÖRLÉSE (KÜLÖN FUTTASD, HA MÁR NEM KELLENEK)
-- ============================================================
-- BEGIN;
-- DELETE FROM purchase_orders WHERE note LIKE '[TESZT BESZERZÉS]%';
-- DELETE FROM inventory_movements WHERE note='[TESZT BESZERZÉS] nyitó tesztkészlet';
-- DELETE FROM product_stock_balances b
-- WHERE b.location_id IS NULL
--   AND NOT EXISTS (SELECT 1 FROM inventory_movements m WHERE m.product_id=b.product_id AND m.note <> '[TESZT BESZERZÉS] nyitó tesztkészlet');
-- DELETE FROM product_supplier_terms pst USING suppliers s WHERE pst.supplier_id=s.id AND s.name LIKE '[TESZT] %';
-- DELETE FROM suppliers WHERE name LIKE '[TESZT] %';
-- COMMIT;
