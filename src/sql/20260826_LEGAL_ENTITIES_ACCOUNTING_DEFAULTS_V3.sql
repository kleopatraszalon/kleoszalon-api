BEGIN;

CREATE OR REPLACE FUNCTION vir_fill_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE location_value text;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.work_order_id IS NOT NULL THEN
    SELECT legal_entity_id INTO NEW.legal_entity_id FROM work_orders WHERE id=NEW.work_order_id;
  END IF;
  IF NEW.legal_entity_id IS NULL AND TG_TABLE_NAME='financial_movements' AND NEW.reversal_of_id IS NOT NULL THEN
    SELECT legal_entity_id INTO NEW.legal_entity_id FROM financial_movements WHERE id=NEW.reversal_of_id;
  END IF;
  IF NEW.legal_entity_id IS NULL THEN
    BEGIN
      location_value:=NEW.location_id::text;
    EXCEPTION WHEN undefined_column THEN
      location_value:=NULL;
    END;
    IF NULLIF(location_value,'') IS NOT NULL THEN
      SELECT el.legal_entity_id INTO NEW.legal_entity_id
      FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
      WHERE el.location_id::text=location_value AND el.active=true AND e.active=true
      ORDER BY el.is_default DESC,e.created_at LIMIT 1;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_order_payments_legal_entity ON work_order_payments;
CREATE TRIGGER trg_work_order_payments_legal_entity BEFORE INSERT OR UPDATE OF work_order_id ON work_order_payments FOR EACH ROW EXECUTE FUNCTION vir_fill_legal_entity();
DROP TRIGGER IF EXISTS trg_finance_invoices_legal_entity ON finance_invoices;
CREATE TRIGGER trg_finance_invoices_legal_entity BEFORE INSERT OR UPDATE OF work_order_id,location_id ON finance_invoices FOR EACH ROW EXECUTE FUNCTION vir_fill_legal_entity();
DROP TRIGGER IF EXISTS trg_financial_movements_legal_entity ON financial_movements;
CREATE TRIGGER trg_financial_movements_legal_entity BEFORE INSERT OR UPDATE OF work_order_id,reversal_of_id,location_id ON financial_movements FOR EACH ROW EXECUTE FUNCTION vir_fill_legal_entity();

CREATE OR REPLACE FUNCTION vir_fill_retail_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legal_entity_id IS NULL THEN
    SELECT el.legal_entity_id INTO NEW.legal_entity_id
    FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
    WHERE el.location_id::text=NEW.location_id::text AND el.active=true AND e.active=true
    ORDER BY el.is_default DESC,e.created_at LIMIT 1;
  END IF;
  IF NEW.legal_entity_id IS NULL THEN
    RAISE EXCEPTION 'A termékeladáshoz nincs kibocsátó cég.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF to_regclass('public.retail_sales') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_retail_sales_legal_entity ON retail_sales;
    CREATE TRIGGER trg_retail_sales_legal_entity BEFORE INSERT ON retail_sales FOR EACH ROW EXECUTE FUNCTION vir_fill_retail_legal_entity();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION vir_fill_receipt_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legal_entity_id IS NULL AND NEW.original_receipt_id IS NOT NULL AND to_regclass('public.vir_receipts') IS NOT NULL THEN
    EXECUTE 'SELECT legal_entity_id FROM vir_receipts WHERE id=$1' INTO NEW.legal_entity_id USING NEW.original_receipt_id;
  END IF;
  IF NEW.legal_entity_id IS NULL AND NEW.source_type='WORK_ORDER' THEN
    SELECT legal_entity_id INTO NEW.legal_entity_id FROM work_orders WHERE id::text=NEW.source_id;
  END IF;
  IF NEW.legal_entity_id IS NULL AND NEW.source_type='RETAIL_SALE' AND to_regclass('public.retail_sales') IS NOT NULL THEN
    EXECUTE 'SELECT legal_entity_id FROM retail_sales WHERE id::text=$1' INTO NEW.legal_entity_id USING NEW.source_id;
  END IF;
  RETURN NEW;
END $$;

DO $$ BEGIN
  IF to_regclass('public.vir_receipts') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_vir_receipts_legal_entity ON vir_receipts;
    CREATE TRIGGER trg_vir_receipts_legal_entity BEFORE INSERT ON vir_receipts FOR EACH ROW EXECUTE FUNCTION vir_fill_receipt_legal_entity();
  END IF;
END $$;

COMMIT;
