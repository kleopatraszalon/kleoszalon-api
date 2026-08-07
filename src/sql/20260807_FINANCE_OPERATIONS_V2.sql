BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS financial_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  name text NOT NULL,
  account_type text NOT NULL DEFAULT 'cash',
  currency text NOT NULL DEFAULT 'HUF',
  opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_accounts_type_ck CHECK (account_type IN ('cash','bank','card','voucher','other'))
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_accounts_location_name_uq
ON financial_accounts(COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE IF NOT EXISTS financial_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  direction text NOT NULL,
  name text NOT NULL,
  code text,
  active boolean NOT NULL DEFAULT true,
  system_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_categories_direction_ck CHECK(direction IN ('income','expense','both'))
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_categories_system_uq
ON financial_categories(system_key)
WHERE system_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS financial_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  category_id uuid REFERENCES financial_categories(id) ON DELETE SET NULL,
  direction text NOT NULL,
  amount numeric(14,2) NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  reference_type text,
  reference_id text,
  counterparty text,
  note text,
  created_by text,
  reversed_by_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_movements_direction_ck CHECK(direction IN ('income','expense')),
  CONSTRAINT financial_movements_amount_ck CHECK(amount > 0)
);

CREATE INDEX IF NOT EXISTS financial_movements_account_date_idx
ON financial_movements(account_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS financial_movements_location_date_idx
ON financial_movements(location_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS financial_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  source_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  destination_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL,
  transferred_at timestamptz NOT NULL DEFAULT now(),
  note text,
  created_by text,
  source_movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  destination_movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_transfers_accounts_ck CHECK(source_account_id <> destination_account_id),
  CONSTRAINT financial_transfers_amount_ck CHECK(amount > 0)
);

CREATE INDEX IF NOT EXISTS financial_transfers_date_idx
ON financial_transfers(transferred_at DESC);

CREATE TABLE IF NOT EXISTS financial_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  work_order_id text,
  account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'completed',
  refunded_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_refunds_amount_ck CHECK(amount > 0),
  CONSTRAINT financial_refunds_status_ck CHECK(status IN ('pending','completed','cancelled'))
);

CREATE INDEX IF NOT EXISTS financial_refunds_workorder_idx
ON financial_refunds(work_order_id, refunded_at DESC);

INSERT INTO financial_categories(direction,name,system_key)
VALUES
 ('income','Egyéb bevétel','other_income'),
 ('expense','Egyéb kiadás','other_expense'),
 ('expense','Beszerzés','procurement_expense'),
 ('expense','Visszatérítés / refund','refund_expense'),
 ('both','Pénzátvezetés','internal_transfer')
ON CONFLICT(system_key) DO NOTHING;

INSERT INTO financial_accounts(location_id,name,account_type,currency,opening_balance)
SELECT l.id,'Készpénz pénztár','cash','HUF',0
FROM locations l
WHERE NOT EXISTS(
  SELECT 1 FROM financial_accounts a
  WHERE a.location_id=l.id AND lower(a.name)=lower('Készpénz pénztár')
);

COMMIT;
