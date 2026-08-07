BEGIN;

CREATE TABLE IF NOT EXISTS procurement_approval_settings (
  id integer PRIMARY KEY DEFAULT 1,
  approval_threshold numeric(14,2) NOT NULL DEFAULT 50000,
  price_variance_warning_pct numeric(8,2) NOT NULL DEFAULT 10,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT procurement_approval_settings_singleton CHECK (id = 1),
  CONSTRAINT procurement_threshold_nonnegative CHECK (approval_threshold >= 0),
  CONSTRAINT procurement_price_variance_nonnegative CHECK (price_variance_warning_pct >= 0)
);

INSERT INTO procurement_approval_settings (id, approval_threshold, price_variance_warning_pct)
VALUES (1, 50000, 10)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS approval_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS approval_requested_by text,
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS approved_by text,
  ADD COLUMN IF NOT EXISTS rejected_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejected_by text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS approved_total numeric(14,2),
  ADD COLUMN IF NOT EXISTS document_number text;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='purchase_orders_approval_status_check') THEN
    ALTER TABLE purchase_orders ADD CONSTRAINT purchase_orders_approval_status_check
      CHECK (approval_status IN ('not_requested','pending','approved','rejected','auto_approved'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS purchase_orders_document_number_uq
  ON purchase_orders(document_number) WHERE document_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS purchase_orders_approval_idx
  ON purchase_orders(approval_status, created_at DESC);

CREATE TABLE IF NOT EXISTS procurement_approval_events (
  id bigserial PRIMARY KEY,
  purchase_order_id bigint NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_key text,
  note text,
  order_total numeric(14,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT procurement_approval_event_type_check CHECK (event_type IN ('requested','auto_approved','approved','rejected','ordered','document_generated'))
);
CREATE INDEX IF NOT EXISTS procurement_approval_events_order_idx
  ON procurement_approval_events(purchase_order_id, created_at DESC);

COMMIT;
