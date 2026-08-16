BEGIN;

CREATE TABLE IF NOT EXISTS procurement_receipt_costs (
  id bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  purchase_order_item_id bigint NOT NULL REFERENCES purchase_order_items(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  received_quantity numeric(14,3) NOT NULL CHECK (received_quantity > 0),
  net_unit_price numeric(14,4) NOT NULL CHECK (net_unit_price >= 0),
  tax_rate_pct numeric(8,4) NOT NULL DEFAULT 0 CHECK (tax_rate_pct >= 0 AND tax_rate_pct <= 100),
  ancillary_cost_total numeric(14,2) NOT NULL DEFAULT 0 CHECK (ancillary_cost_total >= 0),
  net_total numeric(14,2) NOT NULL,
  tax_total numeric(14,2) NOT NULL,
  gross_total numeric(14,2) NOT NULL,
  landed_total numeric(14,2) NOT NULL,
  landed_unit_cost numeric(14,2) NOT NULL,
  document_number text NOT NULL,
  received_by text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  cost_components jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (abs(gross_total - (net_total + tax_total)) <= 0.01),
  CHECK (abs(landed_total - (gross_total + ancillary_cost_total)) <= 0.01),
  CHECK (abs(landed_total - (landed_unit_cost * received_quantity)) <= GREATEST(0.01, received_quantity * 0.01))
);

CREATE INDEX IF NOT EXISTS procurement_receipt_costs_order_idx
  ON procurement_receipt_costs(purchase_order_id, received_at DESC);
CREATE INDEX IF NOT EXISTS procurement_receipt_costs_item_idx
  ON procurement_receipt_costs(purchase_order_item_id, received_at DESC);
CREATE INDEX IF NOT EXISTS procurement_receipt_costs_document_idx
  ON procurement_receipt_costs(document_number);

ALTER TABLE purchase_order_items
  ADD COLUMN IF NOT EXISTS last_net_unit_price numeric(14,4),
  ADD COLUMN IF NOT EXISTS last_tax_rate_pct numeric(8,4),
  ADD COLUMN IF NOT EXISTS last_ancillary_cost_total numeric(14,2),
  ADD COLUMN IF NOT EXISTS last_receipt_document_number text;

COMMIT;
