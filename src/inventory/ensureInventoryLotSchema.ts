import db from "../db";
import { ensureInventoryOperationsSchema } from "./ensureInventoryOperationsSchema";

let ready: Promise<void> | null = null;

export function ensureInventoryLotSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await ensureInventoryOperationsSchema();
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      ALTER TABLE products ADD COLUMN IF NOT EXISTS lot_tracking_enabled boolean NOT NULL DEFAULT false;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS expiry_tracking_enabled boolean NOT NULL DEFAULT false;
      ALTER TABLE products ADD COLUMN IF NOT EXISTS fefo_enabled boolean NOT NULL DEFAULT false;

      CREATE TABLE IF NOT EXISTS inventory_lots (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        lot_code text NOT NULL,
        manufactured_at date NULL,
        expires_at date NULL,
        supplier_id bigint NULL,
        source_record_type text NULL,
        source_record_id text NULL,
        note text NULL,
        created_by text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_lots_product_code_uq
        ON inventory_lots(product_id,lower(lot_code));
      CREATE INDEX IF NOT EXISTS inventory_lots_product_expiry_idx
        ON inventory_lots(product_id,expires_at,created_at);

      CREATE TABLE IF NOT EXISTS inventory_warehouse_lot_balances (
        id bigserial PRIMARY KEY,
        warehouse_id bigint NOT NULL REFERENCES inventory_warehouses(id) ON DELETE CASCADE,
        lot_id uuid NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
        quantity numeric(16,3) NOT NULL DEFAULT 0 CHECK(quantity>=0),
        unit_cost numeric(16,4) NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(warehouse_id,lot_id)
      );
      CREATE INDEX IF NOT EXISTS inventory_warehouse_lot_balances_fefo_idx
        ON inventory_warehouse_lot_balances(warehouse_id,lot_id,quantity);

      CREATE TABLE IF NOT EXISTS inventory_movement_lot_allocations (
        id bigserial PRIMARY KEY,
        movement_id text NOT NULL,
        lot_id uuid NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
        lot_code_snapshot text NULL,
        quantity numeric(16,3) NOT NULL,
        unit_cost numeric(16,4) NOT NULL DEFAULT 0,
        allocation_kind text NOT NULL DEFAULT 'lot' CHECK(allocation_kind IN('lot','legacy_untracked')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS inventory_movement_lot_allocations_movement_idx
        ON inventory_movement_lot_allocations(movement_id);
      CREATE INDEX IF NOT EXISTS inventory_movement_lot_allocations_lot_idx
        ON inventory_movement_lot_allocations(lot_id,created_at DESC);

      CREATE TABLE IF NOT EXISTS inventory_transfer_lot_allocations (
        id bigserial PRIMARY KEY,
        source_type text NOT NULL,
        source_id text NOT NULL,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
        lot_id uuid NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
        lot_code_snapshot text NULL,
        quantity numeric(16,3) NOT NULL CHECK(quantity>0),
        unit_cost numeric(16,4) NOT NULL DEFAULT 0,
        allocation_kind text NOT NULL DEFAULT 'lot' CHECK(allocation_kind IN('lot','legacy_untracked')),
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inventory_transfer_lot_allocations_uq
        ON inventory_transfer_lot_allocations(source_type,source_id,COALESCE(lot_id,'00000000-0000-0000-0000-000000000000'::uuid),allocation_kind);
      CREATE INDEX IF NOT EXISTS inventory_transfer_lot_allocations_source_idx
        ON inventory_transfer_lot_allocations(source_type,source_id);

      DO $$ BEGIN
        IF to_regclass('public.purchase_order_items') IS NOT NULL THEN
          ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS last_lot_code text;
          ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS last_expires_at date;
        END IF;
      END $$;
    `);
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}
