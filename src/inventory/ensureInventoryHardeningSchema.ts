import db from "../db";

let ready: Promise<void> | null = null;

export function ensureInventoryHardeningSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      DO $$ BEGIN
        IF to_regclass('public.inventory_movements') IS NOT NULL THEN
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS warehouse_id bigint;
          ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS operation_group_id uuid;

          DROP INDEX IF EXISTS inventory_movements_workorder_product_location_consumption_uq;
          DROP INDEX IF EXISTS inventory_movements_workorder_product_global_consumption_uq;

          CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_warehouse_consumption_uq
            ON inventory_movements(work_order_id,product_id,warehouse_id)
            WHERE movement_type='work_order_consumption' AND work_order_id IS NOT NULL AND warehouse_id IS NOT NULL;

          CREATE UNIQUE INDEX IF NOT EXISTS inventory_movements_workorder_product_legacy_consumption_uq
            ON inventory_movements(work_order_id,product_id)
            WHERE movement_type='work_order_consumption' AND work_order_id IS NOT NULL AND warehouse_id IS NULL;
        END IF;
      END $$;
    `);
  })().catch((error) => {
    ready = null;
    throw error;
  });
  return ready;
}
