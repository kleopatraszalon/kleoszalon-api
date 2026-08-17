import db from "../db";

let ready: Promise<void> | null = null;

export function ensureInventoryMinMaxCompliance(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      DO $$ BEGIN
        IF to_regclass('public.inventory_warehouse_balances') IS NOT NULL THEN
          ALTER TABLE inventory_warehouse_balances
            ADD COLUMN IF NOT EXISTS max_quantity numeric(16,3) NOT NULL DEFAULT 0;
          UPDATE inventory_warehouse_balances
             SET max_quantity=CASE
               WHEN max_quantity>0 THEN max_quantity
               WHEN COALESCE(optimal_quantity,0)>0 THEN optimal_quantity
               WHEN min_quantity>0 THEN min_quantity*2
               ELSE 0 END
           WHERE max_quantity<=0;
          UPDATE inventory_warehouse_balances
             SET optimal_quantity=max_quantity
           WHERE COALESCE(optimal_quantity,0) IS DISTINCT FROM max_quantity;
        END IF;

        IF to_regclass('public.product_stock_balances') IS NOT NULL THEN
          ALTER TABLE product_stock_balances
            ADD COLUMN IF NOT EXISTS max_quantity numeric(16,3) NOT NULL DEFAULT 0;
          UPDATE product_stock_balances
             SET max_quantity=CASE
               WHEN max_quantity>0 THEN max_quantity
               WHEN COALESCE(optimal_quantity,0)>0 THEN optimal_quantity
               WHEN COALESCE(min_quantity,0)>0 THEN min_quantity*2
               ELSE 0 END
           WHERE max_quantity<=0;
          UPDATE product_stock_balances
             SET optimal_quantity=max_quantity
           WHERE COALESCE(optimal_quantity,0) IS DISTINCT FROM max_quantity;
        END IF;
      END $$;

      CREATE OR REPLACE FUNCTION kleo_inventory_minmax_normalize()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        NEW.min_quantity:=GREATEST(0,COALESCE(NEW.min_quantity,0));

        IF TG_OP='UPDATE'
           AND NEW.optimal_quantity IS DISTINCT FROM OLD.optimal_quantity
           AND NEW.max_quantity IS NOT DISTINCT FROM OLD.max_quantity THEN
          NEW.max_quantity:=COALESCE(NEW.optimal_quantity,0);
        ELSIF TG_OP='UPDATE'
           AND NEW.max_quantity IS DISTINCT FROM OLD.max_quantity THEN
          NEW.optimal_quantity:=COALESCE(NEW.max_quantity,0);
        END IF;

        IF COALESCE(NEW.max_quantity,0)<=0 THEN
          NEW.max_quantity:=CASE
            WHEN COALESCE(NEW.optimal_quantity,0)>0 THEN NEW.optimal_quantity
            WHEN NEW.min_quantity>0 THEN NEW.min_quantity*2
            ELSE 0 END;
        END IF;
        IF NEW.max_quantity>0 AND NEW.max_quantity<NEW.min_quantity THEN
          RAISE EXCEPTION 'A maximum készletszint nem lehet kisebb a minimum készletszintnél.' USING ERRCODE='23514';
        END IF;
        NEW.optimal_quantity:=NEW.max_quantity;
        RETURN NEW;
      END $$;

      DO $$ BEGIN
        IF to_regclass('public.inventory_warehouse_balances') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS trg_kleo_inventory_minmax_normalize ON inventory_warehouse_balances;
          CREATE TRIGGER trg_kleo_inventory_minmax_normalize
            BEFORE INSERT OR UPDATE OF min_quantity,optimal_quantity,max_quantity
            ON inventory_warehouse_balances
            FOR EACH ROW EXECUTE FUNCTION kleo_inventory_minmax_normalize();
        END IF;
        IF to_regclass('public.product_stock_balances') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS trg_kleo_legacy_minmax_normalize ON product_stock_balances;
          CREATE TRIGGER trg_kleo_legacy_minmax_normalize
            BEFORE INSERT OR UPDATE OF min_quantity,optimal_quantity,max_quantity
            ON product_stock_balances
            FOR EACH ROW EXECUTE FUNCTION kleo_inventory_minmax_normalize();
        END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS salon_stock_requests(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        location_id uuid NOT NULL REFERENCES locations(id),
        product_id uuid NOT NULL REFERENCES products(id),
        requested_quantity numeric(14,3) NOT NULL CHECK(requested_quantity>0),
        approved_quantity numeric(14,3),
        supplied_quantity numeric(14,3) NOT NULL DEFAULT 0,
        status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','approved','partially_supplied','supplied','cancelled')),
        source text NOT NULL DEFAULT 'manual',
        source_work_order_id uuid,
        note text,
        created_by text,
        approved_by text,
        created_at timestamptz DEFAULT now(),
        approved_at timestamptz,
        updated_at timestamptz DEFAULT now()
      );
      ALTER TABLE salon_stock_requests ADD COLUMN IF NOT EXISTS purchase_order_id bigint;
      CREATE INDEX IF NOT EXISTS salon_stock_requests_open_idx
        ON salon_stock_requests(location_id,product_id,status,created_at DESC);

      CREATE OR REPLACE FUNCTION kleo_minmax_auto_replenishment()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        v_location uuid;
        v_target numeric(16,3);
        v_request numeric(16,3);
      BEGIN
        IF NEW.quantity>=OLD.quantity THEN RETURN NEW; END IF;
        IF COALESCE(NEW.min_quantity,0)<=0 OR NEW.quantity>NEW.min_quantity THEN RETURN NEW; END IF;

        SELECT NULLIF(w.location_id,'')::uuid INTO v_location
          FROM inventory_warehouses w
         WHERE w.id=NEW.warehouse_id AND w.active=true;
        IF v_location IS NULL THEN RETURN NEW; END IF;

        v_target:=CASE
          WHEN COALESCE(NEW.max_quantity,0)>NEW.min_quantity THEN NEW.max_quantity
          ELSE NEW.min_quantity*2 END;
        v_request:=GREATEST(0.001,v_target-NEW.quantity);

        IF NOT EXISTS(
          SELECT 1 FROM salon_stock_requests r
           WHERE r.location_id=v_location AND r.product_id=NEW.product_id
             AND r.status IN('requested','approved','partially_supplied')
        ) THEN
          INSERT INTO salon_stock_requests(
            location_id,product_id,requested_quantity,status,source,note,created_by
          ) VALUES(
            v_location,NEW.product_id,v_request,'requested','minmax_auto',
            'Automatikus min/max készletfeltöltés: a készlet elérte vagy alulmúlta a minimumot; feltöltési cél a maximum készletszint.',
            'system:minmax-replenishment'
          );
        END IF;
        RETURN NEW;
      END $$;

      DO $$ BEGIN
        IF to_regclass('public.inventory_warehouse_balances') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS trg_kleo_minmax_auto_replenishment ON inventory_warehouse_balances;
          CREATE TRIGGER trg_kleo_minmax_auto_replenishment
            AFTER UPDATE OF quantity ON inventory_warehouse_balances
            FOR EACH ROW EXECUTE FUNCTION kleo_minmax_auto_replenishment();
        END IF;
      END $$;
    `);
  })().catch(error => {
    ready = null;
    throw error;
  });
  return ready;
}

export async function inventoryMinMaxStatus() {
  await ensureInventoryMinMaxCompliance();
  const { rows } = await db.query(`
    SELECT COUNT(*)::int balances,
           COUNT(*) FILTER(WHERE min_quantity>0 AND max_quantity>=min_quantity)::int configured,
           COUNT(*) FILTER(WHERE min_quantity>0 AND quantity<=min_quantity)::int below_minimum,
           COUNT(*) FILTER(WHERE max_quantity>0 AND max_quantity<min_quantity)::int invalid
      FROM inventory_warehouse_balances
  `);
  return rows[0] || { balances:0,configured:0,below_minimum:0,invalid:0 };
}

export function startInventoryMinMaxCompliance() {
  ensureInventoryMinMaxCompliance()
    .then(() => console.log("[INVENTORY MIN/MAX] schema and automatic replenishment ready"))
    .catch(error => console.error("[INVENTORY MIN/MAX] bootstrap failed", error?.message || error));
}
