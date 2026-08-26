BEGIN;

-- Az időpontfoglalás és a munkalap operatív folyamat. Új telepítésnél előfordulhat,
-- hogy a cégtörzs még nincs feltöltve. Ilyenkor a vendégfoglalást nem szabad
-- blokkolni, viszont pénzügyi bizonyíték (fizetés/számla) nem keletkezhet addig,
-- amíg a munkalaphoz nincs aktív kibocsátó cég rendelve.
CREATE OR REPLACE FUNCTION vir_default_work_order_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  active_count integer:=0;
  selected_id uuid;
  default_id uuid;
BEGIN
  IF NEW.location_id IS NULL THEN
    RAISE EXCEPTION 'A munkalaphoz nincs szalon rendelve.' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*)::int INTO active_count
  FROM legal_entity_locations el
  JOIN legal_entities e ON e.id=el.legal_entity_id
  WHERE el.location_id=NEW.location_id AND el.active=true AND e.active=true;

  -- Setup-safe üzem: a foglalás/munkalap létrejöhet cég nélkül. A későbbi
  -- pénzügyi műveleteket a vir_fill_legal_entity továbbra is fail-closed védi.
  IF active_count=0 THEN
    IF NEW.legal_entity_id IS NOT NULL THEN
      RAISE EXCEPTION 'A kiválasztott cég nincs aktívan hozzárendelve ehhez a szalonhoz.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.legal_entity_id IS NULL AND NULLIF(btrim(COALESCE(NEW.created_by,'')),'') IS NOT NULL THEN
    SELECT s.legal_entity_id INTO selected_id
    FROM legal_entity_workorder_selections s
    JOIN legal_entity_locations el ON el.legal_entity_id=s.legal_entity_id
    JOIN legal_entities e ON e.id=s.legal_entity_id
    WHERE s.actor_key=NEW.created_by
      AND s.selected_at>now()-interval '2 hours'
      AND el.location_id=NEW.location_id
      AND el.active=true AND e.active=true
    LIMIT 1;
    IF selected_id IS NOT NULL THEN
      NEW.legal_entity_id:=selected_id;
      DELETE FROM legal_entity_workorder_selections WHERE actor_key=NEW.created_by;
    END IF;
  END IF;

  -- Online/automatizált folyamatnál és normál munkalapnál is a szalon
  -- explicit alapértelmezett cége az elsődleges automatikus választás.
  IF NEW.legal_entity_id IS NULL THEN
    SELECT el.legal_entity_id INTO default_id
    FROM legal_entity_locations el
    JOIN legal_entities e ON e.id=el.legal_entity_id
    WHERE el.location_id=NEW.location_id
      AND el.active=true AND e.active=true AND el.is_default=true
    LIMIT 1;
    IF default_id IS NOT NULL THEN NEW.legal_entity_id:=default_id; END IF;
  END IF;

  IF NEW.legal_entity_id IS NULL AND active_count=1 THEN
    SELECT el.legal_entity_id INTO NEW.legal_entity_id
    FROM legal_entity_locations el
    JOIN legal_entities e ON e.id=el.legal_entity_id
    WHERE el.location_id=NEW.location_id AND el.active=true AND e.active=true
    LIMIT 1;
  END IF;

  IF NEW.legal_entity_id IS NULL AND active_count>1 THEN
    RAISE EXCEPTION 'Ebben a szalonban több cég működik. A munkalap létrehozása előtt válassza ki a kibocsátó céget.' USING ERRCODE='23514';
  END IF;

  IF NEW.legal_entity_id IS NULL OR NOT EXISTS(
    SELECT 1 FROM legal_entity_locations el
    JOIN legal_entities e ON e.id=el.legal_entity_id
    WHERE el.legal_entity_id=NEW.legal_entity_id
      AND el.location_id=NEW.location_id
      AND el.active=true AND e.active=true
  ) THEN
    RAISE EXCEPTION 'A kiválasztott cég nincs hozzárendelve ehhez a szalonhoz.' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_orders_default_legal_entity ON work_orders;
CREATE TRIGGER trg_work_orders_default_legal_entity
BEFORE INSERT ON work_orders
FOR EACH ROW EXECUTE FUNCTION vir_default_work_order_legal_entity();

-- A cég nélküli operatív munkalapot még ki lehet választott céghez rendelni,
-- de pénzügyi bizonyítékot nem engedünk létrehozni addig, amíg ez nem történt meg.
CREATE OR REPLACE FUNCTION vir_fill_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE location_value text;
BEGIN
  IF NEW.legal_entity_id IS NOT NULL THEN RETURN NEW; END IF;
  IF NEW.work_order_id IS NOT NULL THEN
    SELECT legal_entity_id INTO NEW.legal_entity_id FROM work_orders WHERE id=NEW.work_order_id;
    IF NEW.legal_entity_id IS NULL THEN
      RAISE EXCEPTION 'A munkalap pénzügyi művelete előtt válasszon kibocsátó céget.' USING ERRCODE='23514';
    END IF;
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

COMMIT;
