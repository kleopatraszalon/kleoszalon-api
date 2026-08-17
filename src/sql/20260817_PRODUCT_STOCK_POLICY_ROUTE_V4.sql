BEGIN;
UPDATE vir_module_definitions SET route='/spec/product-stock-policy',updated_at=now() WHERE module_key='product-stock-policy';
UPDATE menus SET route='/spec/product-stock-policy' WHERE code='inventory.product-stock-policy';
INSERT INTO schema_migrations(version,description)
VALUES('20260817_PRODUCT_STOCK_POLICY_ROUTE_V4','Termék készletszabály kezelőfelület átvezetése a generikus VIR /spec útvonalra')
ON CONFLICT(version) DO NOTHING;
COMMIT;
