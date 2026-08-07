import db from "../db";

let ready: Promise<void> | null = null;

export function ensureProcurementSchema(): Promise<void> {
  if (ready) return ready;
  ready = (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS product_stock_balances (
        id bigserial PRIMARY KEY,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        location_id text,
        quantity numeric(14,3) NOT NULL DEFAULT 0,
        min_quantity numeric(14,3) NOT NULL DEFAULT 0,
        unit_cost numeric(14,2) NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS min_quantity numeric(14,3) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE product_stock_balances ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2) NOT NULL DEFAULT 0`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS inventory_movements (
        id bigserial PRIMARY KEY,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        location_id text,
        work_order_id text,
        movement_type text NOT NULL,
        quantity numeric(14,3) NOT NULL DEFAULT 0,
        balance_after numeric(14,3),
        unit_cost numeric(14,2) NOT NULL DEFAULT 0,
        stock_value_after numeric(14,2) NOT NULL DEFAULT 0,
        note text,
        created_by text,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS unit_cost numeric(14,2) NOT NULL DEFAULT 0`);
    await db.query(`ALTER TABLE inventory_movements ADD COLUMN IF NOT EXISTS stock_value_after numeric(14,2) NOT NULL DEFAULT 0`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id bigserial PRIMARY KEY,
        name text NOT NULL UNIQUE,
        tax_number text,
        email text,
        phone text,
        contact_name text,
        address text,
        website text,
        payment_terms_days integer NOT NULL DEFAULT 0,
        default_lead_time_days integer NOT NULL DEFAULT 3,
        active boolean NOT NULL DEFAULT true,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS product_supplier_terms (
        id bigserial PRIMARY KEY,
        product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        supplier_id bigint NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
        supplier_product_code text,
        unit_price numeric(14,2) NOT NULL DEFAULT 0,
        minimum_order_quantity numeric(14,3) NOT NULL DEFAULT 1,
        lead_time_days integer NOT NULL DEFAULT 3,
        preferred boolean NOT NULL DEFAULT false,
        active boolean NOT NULL DEFAULT true,
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(product_id,supplier_id)
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id bigserial PRIMARY KEY,
        location_id text,
        supplier_name text NOT NULL,
        supplier_id bigint REFERENCES suppliers(id),
        status text NOT NULL DEFAULT 'draft',
        expected_at date,
        note text,
        created_by text,
        updated_by text,
        ordered_at timestamptz,
        received_at timestamptz,
        cancelled_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_id bigint REFERENCES suppliers(id)`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_requested'`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approval_requested_at timestamptz`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approval_requested_by text`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_at timestamptz`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_by text`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rejected_at timestamptz`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rejected_by text`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rejection_reason text`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS approved_total numeric(14,2)`);
    await db.query(`ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS document_number text`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS purchase_order_items (
        id bigserial PRIMARY KEY,
        purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        product_id uuid NOT NULL REFERENCES products(id),
        ordered_quantity numeric(14,3) NOT NULL,
        received_quantity numeric(14,3) NOT NULL DEFAULT 0,
        unit_cost numeric(14,2) NOT NULL DEFAULT 0,
        actual_unit_cost numeric(14,2),
        note text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await db.query(`
      CREATE TABLE IF NOT EXISTS procurement_approval_settings (
        id integer PRIMARY KEY DEFAULT 1,
        approval_threshold numeric(14,2) NOT NULL DEFAULT 50000,
        price_variance_warning_pct numeric(8,2) NOT NULL DEFAULT 10,
        updated_by text,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await db.query(`INSERT INTO procurement_approval_settings(id,approval_threshold,price_variance_warning_pct) VALUES(1,50000,10) ON CONFLICT(id) DO NOTHING`);

    await db.query(`
      CREATE TABLE IF NOT EXISTS procurement_approval_events (
        id bigserial PRIMARY KEY,
        purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        event_type text NOT NULL,
        actor_key text,
        note text,
        order_total numeric(14,2),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    await db.query(`CREATE INDEX IF NOT EXISTS product_stock_balances_product_idx ON product_stock_balances(product_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS inventory_movements_created_idx ON inventory_movements(created_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS purchase_orders_approval_idx ON purchase_orders(approval_status,created_at DESC)`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_document_number_uq ON purchase_orders(document_number) WHERE document_number IS NOT NULL`);
  })().catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}
