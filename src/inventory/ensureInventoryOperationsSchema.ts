import db from "../db";

let ready: Promise<void> | null = null;

export function ensureInventoryOperationsSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS inventory_warehouses (
        id bigserial PRIMARY KEY,
        location_id text NULL,
        code text NULL,
        name text NOT NULL,
        warehouse_type text NOT NULL DEFAULT 'mixed' CHECK (warehouse_type IN ('retail','consumable','mixed','transit')),
        comment text NULL,
        is_default_sale boolean NOT NULL DEFAULT false,
        is_default_consumption boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 100,
        created_by text NULL,
        updated_by text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_warehouses_location_name_uq
        ON inventory_warehouses(COALESCE(location_id,'__central__'), lower(name));
      CREATE INDEX IF NOT EXISTS inventory_warehouses_location_active_idx
        ON inventory_warehouses(location_id,active,sort_order,id);

      CREATE TABLE IF NOT EXISTS inventory_warehouse_balances (
        id bigserial PRIMARY KEY,
        warehouse_id bigint NOT NULL REFERENCES inventory_warehouses(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        quantity numeric(16,3) NOT NULL DEFAULT 0,
        min_quantity numeric(16,3) NOT NULL DEFAULT 0,
        optimal_quantity numeric(16,3) NOT NULL DEFAULT 0,
        unit_cost numeric(16,4) NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(warehouse_id,product_id)
      );
      CREATE INDEX IF NOT EXISTS inventory_warehouse_balances_low_idx
        ON inventory_warehouse_balances(warehouse_id,quantity,min_quantity);

      CREATE TABLE IF NOT EXISTS inventory_settings (
        location_key text PRIMARY KEY,
        cost_method text NOT NULL DEFAULT 'weighted_average' CHECK (cost_method IN ('weighted_average','latest_receipt','product_cost')),
        prevent_negative_stock boolean NOT NULL DEFAULT true,
        stocktake_missing_mode text NOT NULL DEFAULT 'system' CHECK(stocktake_missing_mode IN('system','zero')),
        barcode_increment numeric(16,3) NOT NULL DEFAULT 1,
        updated_by text NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO inventory_settings(location_key) VALUES('__global__') ON CONFLICT(location_key) DO NOTHING;

      CREATE TABLE IF NOT EXISTS inventory_units (
        id bigserial PRIMARY KEY,
        code text NOT NULL UNIQUE,
        name text NOT NULL,
        precision_digits integer NOT NULL DEFAULT 3 CHECK(precision_digits BETWEEN 0 AND 6),
        active boolean NOT NULL DEFAULT true,
        sort_order integer NOT NULL DEFAULT 100,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO inventory_units(code,name,precision_digits,sort_order) VALUES
        ('db','Darab',0,10),('ml','Milliliter',3,20),('l','Liter',3,30),('g','Gramm',3,40),('kg','Kilogramm',3,50),
        ('csomag','Csomag',0,60),('par','Pár',0,70),('tekercs','Tekercs',0,80),('ampulla','Ampulla',0,90)
      ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,precision_digits=EXCLUDED.precision_digits;

      CREATE TABLE IF NOT EXISTS inventory_stocktakes (
        id bigserial PRIMARY KEY,
        warehouse_id bigint NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
        status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','submitted','approved','cancelled')),
        product_category_id uuid NULL,
        note text NULL,
        created_by text NULL,
        submitted_by text NULL,
        approved_by text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        submitted_at timestamptz NULL,
        approved_at timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS inventory_stocktakes_warehouse_status_idx
        ON inventory_stocktakes(warehouse_id,status,created_at DESC);

      CREATE TABLE IF NOT EXISTS inventory_stocktake_items (
        id bigserial PRIMARY KEY,
        stocktake_id bigint NOT NULL REFERENCES inventory_stocktakes(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        product_name_snapshot text NULL,
        barcode_snapshot text NULL,
        expected_quantity numeric(16,3) NOT NULL DEFAULT 0,
        counted_quantity numeric(16,3) NULL,
        unit_cost numeric(16,4) NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(stocktake_id,product_id)
      );

      CREATE TABLE IF NOT EXISTS inventory_transfers (
        id bigserial PRIMARY KEY,
        source_warehouse_id bigint NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
        destination_warehouse_id bigint NOT NULL REFERENCES inventory_warehouses(id) ON DELETE RESTRICT,
        status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','in_transit','received','cancelled')),
        document_number text NULL,
        note text NULL,
        created_by text NULL,
        dispatched_by text NULL,
        received_by text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        dispatched_at timestamptz NULL,
        received_at timestamptz NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK(source_warehouse_id<>destination_warehouse_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_transfers_document_uq
        ON inventory_transfers(document_number) WHERE document_number IS NOT NULL;
      CREATE INDEX IF NOT EXISTS inventory_transfers_source_idx ON inventory_transfers(source_warehouse_id,status,created_at DESC);
      CREATE INDEX IF NOT EXISTS inventory_transfers_destination_idx ON inventory_transfers(destination_warehouse_id,status,created_at DESC);

      CREATE TABLE IF NOT EXISTS inventory_transfer_items (
        id bigserial PRIMARY KEY,
        transfer_id bigint NOT NULL REFERENCES inventory_transfers(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        product_name_snapshot text NULL,
        quantity numeric(16,3) NOT NULL CHECK(quantity>0),
        unit_cost numeric(16,4) NOT NULL DEFAULT 0,
        UNIQUE(transfer_id,product_id)
      );

      DO $$ BEGIN
        IF to_regclass('public.product_stock_balances') IS NOT NULL THEN
          ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS optimal_quantity numeric(16,3) NOT NULL DEFAULT 0;
        END IF;
        IF to_regclass('public.inventory_movements') IS NOT NULL THEN
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS warehouse_id bigint;
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS destination_warehouse_id bigint;
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS supplier_id bigint;
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS document_number text;
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS operation_group_id uuid;
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS counterparty_name text;
          CREATE INDEX IF NOT EXISTS inventory_movements_warehouse_created_idx ON inventory_movements(warehouse_id,created_at DESC);
          CREATE INDEX IF NOT EXISTS inventory_movements_operation_group_idx ON inventory_movements(operation_group_id);
        END IF;
      END $$;

      INSERT INTO inventory_warehouses(location_id,code,name,warehouse_type,is_default_sale,is_default_consumption,sort_order,comment)
      VALUES(NULL,'CENTRAL_PRODUCTS','Központi termék raktár','retail',true,false,10,'Automatikusan létrehozott központi értékesítési raktár'),
            (NULL,'CENTRAL_CONSUMABLES','Központi fogyóanyag raktár','consumable',false,true,20,'Automatikusan létrehozott központi fogyóanyag raktár')
      ON CONFLICT DO NOTHING;

      DO $$ DECLARE r record; BEGIN
        IF to_regclass('public.locations') IS NOT NULL THEN
          FOR r IN SELECT id::text AS id,name FROM locations LOOP
            INSERT INTO inventory_warehouses(location_id,code,name,warehouse_type,is_default_sale,is_default_consumption,sort_order,comment)
            VALUES(r.id,'PRODUCTS','Termék raktár','retail',true,false,10,'Alapértelmezett értékesítési raktár')
            ON CONFLICT DO NOTHING;
            INSERT INTO inventory_warehouses(location_id,code,name,warehouse_type,is_default_sale,is_default_consumption,sort_order,comment)
            VALUES(r.id,'CONSUMABLES','Fogyóanyag raktár','consumable',false,true,20,'Alapértelmezett szolgáltatási anyagraktár')
            ON CONFLICT DO NOTHING;
          END LOOP;
        END IF;
      END $$;

      DO $$ BEGIN
        IF to_regclass('public.product_stock_balances') IS NOT NULL THEN
          INSERT INTO inventory_warehouse_balances(warehouse_id,product_id,quantity,min_quantity,optimal_quantity,unit_cost)
          SELECT w.id,b.product_id,COALESCE(b.quantity,0),COALESCE(b.min_quantity,0),
                 CASE WHEN COALESCE(b.optimal_quantity,0)>0 THEN b.optimal_quantity ELSE COALESCE(b.min_quantity,0)*2 END,
                 COALESCE(b.unit_cost,0)
          FROM product_stock_balances b
          JOIN products p ON p.id=b.product_id
          JOIN LATERAL (
            SELECT iw.id
            FROM inventory_warehouses iw
            WHERE iw.active=true
              AND ((b.location_id IS NULL AND iw.location_id IS NULL) OR iw.location_id=b.location_id::text)
            ORDER BY
              CASE WHEN COALESCE((to_jsonb(p)->>'is_service_material')::boolean,false) THEN iw.is_default_consumption ELSE iw.is_default_sale END DESC,
              iw.sort_order,iw.id
            LIMIT 1
          ) w ON true
          ON CONFLICT(warehouse_id,product_id) DO NOTHING;
        END IF;
      END $$;

      CREATE OR REPLACE FUNCTION kleo_sync_legacy_balance_to_warehouse()
      RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE
        v_product uuid;
        v_location text;
        v_delta numeric(16,3):=0;
        v_qty numeric(16,3):=0;
        v_min numeric(16,3):=0;
        v_opt numeric(16,3):=0;
        v_cost numeric(16,4):=0;
        v_is_material boolean:=false;
        v_warehouse bigint;
      BEGIN
        IF current_setting('kleo.inventory_sync',true)='warehouse_to_legacy' THEN
          IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
        END IF;
        v_product:=COALESCE(NEW.product_id,OLD.product_id);
        v_location:=COALESCE(NEW.location_id,OLD.location_id)::text;
        IF TG_OP='INSERT' THEN
          v_delta:=COALESCE(NEW.quantity,0); v_min:=COALESCE(NEW.min_quantity,0); v_opt:=COALESCE(NEW.optimal_quantity,0); v_cost:=COALESCE(NEW.unit_cost,0);
        ELSIF TG_OP='UPDATE' THEN
          v_delta:=COALESCE(NEW.quantity,0)-COALESCE(OLD.quantity,0); v_min:=COALESCE(NEW.min_quantity,0); v_opt:=COALESCE(NEW.optimal_quantity,0); v_cost:=COALESCE(NEW.unit_cost,0);
        ELSE
          v_delta:=-COALESCE(OLD.quantity,0); v_min:=0; v_opt:=0; v_cost:=COALESCE(OLD.unit_cost,0);
        END IF;
        SELECT COALESCE((to_jsonb(p)->>'is_service_material')::boolean,false) INTO v_is_material FROM products p WHERE p.id=v_product;
        SELECT iw.id INTO v_warehouse FROM inventory_warehouses iw
         WHERE iw.active=true AND ((v_location IS NULL AND iw.location_id IS NULL) OR iw.location_id=v_location)
         ORDER BY CASE WHEN v_is_material THEN iw.is_default_consumption ELSE iw.is_default_sale END DESC,iw.sort_order,iw.id LIMIT 1;
        IF v_warehouse IS NULL THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
        INSERT INTO inventory_warehouse_balances(warehouse_id,product_id,quantity,min_quantity,optimal_quantity,unit_cost)
        VALUES(v_warehouse,v_product,v_delta,v_min,CASE WHEN v_opt>0 THEN v_opt ELSE v_min*2 END,v_cost)
        ON CONFLICT(warehouse_id,product_id) DO UPDATE SET
          quantity=inventory_warehouse_balances.quantity+v_delta,
          min_quantity=CASE WHEN TG_OP='DELETE' THEN inventory_warehouse_balances.min_quantity ELSE EXCLUDED.min_quantity END,
          optimal_quantity=CASE WHEN TG_OP='DELETE' THEN inventory_warehouse_balances.optimal_quantity ELSE EXCLUDED.optimal_quantity END,
          unit_cost=CASE WHEN TG_OP='DELETE' THEN inventory_warehouse_balances.unit_cost ELSE EXCLUDED.unit_cost END,
          updated_at=now();
        IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
      END $$;

      DO $$ BEGIN
        IF to_regclass('public.product_stock_balances') IS NOT NULL THEN
          DROP TRIGGER IF EXISTS trg_kleo_sync_legacy_balance_to_warehouse ON product_stock_balances;
          CREATE TRIGGER trg_kleo_sync_legacy_balance_to_warehouse
          AFTER INSERT OR UPDATE OR DELETE ON product_stock_balances
          FOR EACH ROW EXECUTE FUNCTION kleo_sync_legacy_balance_to_warehouse();
        END IF;
      END $$;
    `);
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}
