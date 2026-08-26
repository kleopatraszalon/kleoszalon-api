BEGIN;

CREATE OR REPLACE FUNCTION vir_default_work_order_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.legal_entity_id IS NULL AND NEW.location_id IS NOT NULL THEN
    SELECT el.legal_entity_id INTO NEW.legal_entity_id
    FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id
    WHERE el.location_id=NEW.location_id AND el.active=true AND e.active=true
    ORDER BY el.is_default DESC,e.created_at,el.legal_entity_id LIMIT 1;
  END IF;
  IF NEW.legal_entity_id IS NULL THEN
    RAISE EXCEPTION 'A munkalaphoz nincs kiválasztható kibocsátó cég.' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id WHERE el.legal_entity_id=NEW.legal_entity_id AND el.location_id=NEW.location_id AND el.active=true AND e.active=true) THEN
    RAISE EXCEPTION 'A kiválasztott cég nincs hozzárendelve ehhez a szalonhoz.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_orders_default_legal_entity ON work_orders;
CREATE TRIGGER trg_work_orders_default_legal_entity BEFORE INSERT ON work_orders FOR EACH ROW EXECUTE FUNCTION vir_default_work_order_legal_entity();

CREATE OR REPLACE FUNCTION vir_guard_work_order_legal_entity_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE has_receipt boolean:=false;
BEGIN
  IF NEW.legal_entity_id IS NOT DISTINCT FROM OLD.legal_entity_id THEN RETURN NEW; END IF;
  IF OLD.financial_closed_at IS NOT NULL OR COALESCE(OLD.fully_paid,false)=true OR COALESCE(OLD.payment_status,'')='paid' THEN
    RAISE EXCEPTION 'Pénzügyileg lezárt vagy kifizetett munkalap cége nem módosítható.' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM work_order_payments p WHERE p.work_order_id=OLD.id) THEN
    RAISE EXCEPTION 'Fizetést tartalmazó munkalap cége nem módosítható.' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM finance_invoices i WHERE i.work_order_id=OLD.id) THEN
    RAISE EXCEPTION 'Számlát tartalmazó munkalap cége nem módosítható.' USING ERRCODE='23514';
  END IF;
  IF to_regclass('public.vir_receipts') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM vir_receipts WHERE source_type=''WORK_ORDER'' AND source_id=$1)' INTO has_receipt USING OLD.id::text;
    IF has_receipt THEN RAISE EXCEPTION 'Nyugtát tartalmazó munkalap cége nem módosítható.' USING ERRCODE='23514'; END IF;
  END IF;
  IF NEW.legal_entity_id IS NULL OR NOT EXISTS(SELECT 1 FROM legal_entity_locations el JOIN legal_entities e ON e.id=el.legal_entity_id WHERE el.legal_entity_id=NEW.legal_entity_id AND el.location_id=NEW.location_id AND el.active=true AND e.active=true) THEN
    RAISE EXCEPTION 'A kiválasztott cég nincs hozzárendelve ehhez a szalonhoz.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_orders_guard_legal_entity_change ON work_orders;
CREATE TRIGGER trg_work_orders_guard_legal_entity_change BEFORE UPDATE OF legal_entity_id ON work_orders FOR EACH ROW EXECUTE FUNCTION vir_guard_work_order_legal_entity_change();

COMMIT;
