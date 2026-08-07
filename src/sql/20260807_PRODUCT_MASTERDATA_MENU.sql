BEGIN;

-- ============================================================
-- KLEOSZALON VIR – TERMÉK TÖRZSADAT MENÜK
-- Hierarchia:
--   Terméktípusok
--   Termékcsoportok
--   Alkategóriák
--   Termékek
--
-- A négy oldal a Törzsadatok menü alatt jelenik meg.
-- Újrafuttatható: ON CONFLICT miatt nem duplikál.
-- ============================================================

-- 1) Törzsadatok főmenü biztosítása
INSERT INTO menus (
    code,
    name,
    icon,
    route,
    order_index,
    parent_id,
    feature_key,
    is_active
)
VALUES (
    'masterdata',
    'Törzsadatok',
    'Database',
    NULL,
    145,
    NULL,
    'master_data',
    TRUE
)
ON CONFLICT (code)
DO UPDATE SET
    name        = EXCLUDED.name,
    icon        = EXCLUDED.icon,
    route       = NULL,
    order_index = EXCLUDED.order_index,
    parent_id   = NULL,
    feature_key = EXCLUDED.feature_key,
    is_active   = TRUE;


-- 2) Régi / esetlegesen hibás termék-menük kikapcsolása
--    Csak azokat érinti, amelyek ugyanahhoz a funkcióhoz tartoznak.
UPDATE menus
SET is_active = FALSE
WHERE code IN (
    'masterdata.product-type',
    'masterdata.product-groups-old',
    'masterdata.product-categories-old',
    'masterdata.products-old'
);


-- 3) A négy termék-törzsadat oldal felvétele
WITH master AS (
    SELECT id
    FROM menus
    WHERE code = 'masterdata'
    LIMIT 1
),
items (
    code,
    name,
    icon,
    route,
    order_index,
    feature_key
) AS (
    VALUES
        (
            'masterdata.product-types',
            'Terméktípusok',
            'Tags',
            '/masterdata/product-types',
            50,
            'product_types'
        ),
        (
            'masterdata.product-groups',
            'Termékcsoportok',
            'Layers3',
            '/masterdata/products?view=groups',
            51,
            'product_groups'
        ),
        (
            'masterdata.product-categories',
            'Alkategóriák',
            'FolderTree',
            '/masterdata/products?view=categories',
            52,
            'product_categories'
        ),
        (
            'masterdata.products',
            'Termékek',
            'Package',
            '/masterdata/products',
            53,
            'products'
        )
)
INSERT INTO menus (
    code,
    name,
    icon,
    route,
    order_index,
    parent_id,
    feature_key,
    is_active
)
SELECT
    i.code,
    i.name,
    i.icon,
    i.route,
    i.order_index,
    m.id,
    i.feature_key,
    TRUE
FROM items i
CROSS JOIN master m
ON CONFLICT (code)
DO UPDATE SET
    name        = EXCLUDED.name,
    icon        = EXCLUDED.icon,
    route       = EXCLUDED.route,
    order_index = EXCLUDED.order_index,
    parent_id   = EXCLUDED.parent_id,
    feature_key = EXCLUDED.feature_key,
    is_active   = TRUE;


-- 4) A korábbi "Terméktípusok" rekordot is ugyanarra a helyre igazítjuk,
--    ha már létezik a rendszerben.
UPDATE menus
SET
    name        = 'Terméktípusok',
    route       = '/masterdata/product-types',
    order_index = 50,
    feature_key = 'product_types',
    is_active   = TRUE,
    parent_id   = (SELECT id FROM menus WHERE code = 'masterdata' LIMIT 1)
WHERE code = 'masterdata.product-types';


-- 5) Sorrend biztosítása a termékes blokk körül
--    A következő meglévő törzsadat menüpontok 60-tól folytatódnak.
UPDATE menus SET order_index = 60
WHERE code = 'masterdata.assets';

UPDATE menus SET order_index = 70
WHERE code = 'masterdata.discounts';

UPDATE menus SET order_index = 80
WHERE code = 'masterdata.leave-types';

UPDATE menus SET order_index = 90
WHERE code = 'masterdata.units';

UPDATE menus SET order_index = 100
WHERE code = 'masterdata.price-types';

UPDATE menus SET order_index = 110
WHERE code = 'masterdata.warehouses';

UPDATE menus SET order_index = 120
WHERE code = 'masterdata.movement-types';

UPDATE menus SET order_index = 130
WHERE code = 'masterdata.transaction-types';

UPDATE menus SET order_index = 140
WHERE code = 'masterdata.guest-account-types';


COMMIT;


-- ============================================================
-- ELLENŐRZÉS
-- ============================================================

SELECT
    c.id,
    c.code,
    c.name,
    c.route,
    c.feature_key,
    c.order_index,
    c.is_active,
    p.name AS parent_menu
FROM menus c
LEFT JOIN menus p
    ON p.id = c.parent_id
WHERE c.parent_id = (
    SELECT id
    FROM menus
    WHERE code = 'masterdata'
    LIMIT 1
)
ORDER BY c.order_index, c.name;
