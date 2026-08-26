BEGIN;

CREATE TABLE IF NOT EXISTS legal_entity_workorder_selections(
  actor_key text PRIMARY KEY,
  legal_entity_id uuid NOT NULL REFERENCES legal_entities(id) ON DELETE CASCADE,
  selected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legal_entity_workorder_selections_selected_idx ON legal_entity_workorder_selections(selected_at);

CREATE OR REPLACE FUNCTION vir_default_work_order_legal_entity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  active_count integer:=0;
  selected_id uuid;
BEGIN
  IF NEW.location_id IS NULL THEN
    RAISE EXCEPTION 'A munkalaphoz nincs szalon rendelve.' USING ERRCODE='23514';
  END IF;

  SELECT COUNT(*)::int INTO active_count
  FROM legal_entity_locations el
  JOIN legal_entities e ON e.id=el.legal_entity_id
  WHERE el.location_id=NEW.location_id AND el.active=true AND e.active=true;

  IF active_count=0 THEN
    RAISE EXCEPTION 'Ehhez a szalonhoz nincs aktív kibocsátó cég rendelve.' USING ERRCODE='23514';
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

DELETE FROM legal_entity_workorder_selections WHERE selected_at<now()-interval '24 hours';

COMMIT;
