BEGIN;

ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS allow_cash boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS allow_cashless boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS external_code text,
  ADD COLUMN IF NOT EXISTS comment text;

ALTER TABLE financial_movements
  ADD COLUMN IF NOT EXISTS partner_id bigint,
  ADD COLUMN IF NOT EXISTS payment_method_code text,
  ADD COLUMN IF NOT EXISTS document_type_code text,
  ADD COLUMN IF NOT EXISTS employee_id text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS cancellation_by text;

CREATE TABLE IF NOT EXISTS finance_payment_methods(
  id bigserial PRIMARY KEY,
  location_id text,
  code text NOT NULL,
  name text NOT NULL,
  method_type text NOT NULL DEFAULT 'custom',
  account_id uuid,
  fee_percent numeric(9,4) NOT NULL DEFAULT 0,
  fee_fixed numeric(14,2) NOT NULL DEFAULT 0,
  processing_days integer NOT NULL DEFAULT 0,
  brand_fees jsonb NOT NULL DEFAULT '{}'::jsonb,
  allow_installments boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_payment_methods_scope ON finance_payment_methods(COALESCE(location_id,''),code);

CREATE TABLE IF NOT EXISTS finance_partners(
  id bigserial PRIMARY KEY,
  location_id text,
  partner_type text NOT NULL DEFAULT 'company',
  name text NOT NULL,
  tax_number text,
  email text,
  phone text,
  address text,
  contact_name text,
  note text,
  supplier_id text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS finance_document_types(
  id bigserial PRIMARY KEY,
  location_id text,
  code text NOT NULL,
  name text NOT NULL,
  direction text NOT NULL DEFAULT 'both',
  group_key text NOT NULL DEFAULT 'other',
  system boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE work_order_payments
  ADD COLUMN IF NOT EXISTS payment_method_code text,
  ADD COLUMN IF NOT EXISTS finance_account_id uuid,
  ADD COLUMN IF NOT EXISTS cashier_shift_id bigint,
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS card_brand text,
  ADD COLUMN IF NOT EXISTS fee_amount numeric(14,2) NOT NULL DEFAULT 0;

-- A régi live adatbázisokon ez a tábla korábban csak a cashier route első
-- megnyitásakor jött létre. A Finance/NAV bootstrap azonban előbb fut, ezért
-- a parity migráció saját maga biztosítja az alap táblát az ALTER előtt.
CREATE TABLE IF NOT EXISTS cash_register_movements (
  id bigserial PRIMARY KEY,
  location_id text NOT NULL,
  business_date date NOT NULL DEFAULT CURRENT_DATE,
  direction varchar(8) NOT NULL CHECK (direction IN ('in','out')),
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  reason_code varchar(40) NOT NULL DEFAULT 'other',
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_at timestamptz,
  voided_by text,
  void_reason text
);
CREATE INDEX IF NOT EXISTS cash_register_movements_scope_idx
  ON cash_register_movements (location_id,business_date DESC,created_at DESC);

ALTER TABLE cash_register_movements
  ADD COLUMN IF NOT EXISTS transaction_type_code text,
  ADD COLUMN IF NOT EXISTS reference_no text,
  ADD COLUMN IF NOT EXISTS partner_id bigint,
  ADD COLUMN IF NOT EXISTS employee_id text,
  ADD COLUMN IF NOT EXISTS finance_account_id uuid,
  ADD COLUMN IF NOT EXISTS cashier_shift_id bigint;

CREATE TABLE IF NOT EXISTS cashier_shift_counts(
  id bigserial PRIMARY KEY,
  shift_id bigint NOT NULL,
  location_id text NOT NULL,
  business_date date NOT NULL,
  count_type varchar(20) NOT NULL CHECK(count_type IN('opening','check','handover','accept','closing')),
  handover_id bigint,
  denominations jsonb NOT NULL DEFAULT '{}'::jsonb,
  counted_cash numeric(14,2) NOT NULL DEFAULT 0,
  expected_cash numeric(14,2) NOT NULL DEFAULT 0,
  difference numeric(14,2) NOT NULL DEFAULT 0,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cashier_shift_counts_shift_idx ON cashier_shift_counts(shift_id,created_at DESC);
CREATE INDEX IF NOT EXISTS cashier_shift_counts_location_date_idx ON cashier_shift_counts(location_id,business_date DESC,created_at DESC);

CREATE TABLE IF NOT EXISTS cashier_payment_context(
  id bigserial PRIMARY KEY,
  work_order_id text NOT NULL,
  sequence_no integer NOT NULL DEFAULT 0,
  base_method text NOT NULL,
  amount numeric(14,2) NOT NULL,
  payment_method_code text,
  finance_account_id uuid,
  cashier_shift_id bigint,
  card_brand text,
  fee_amount numeric(14,2) NOT NULL DEFAULT 0,
  expires_at timestamptz NOT NULL DEFAULT(now()+interval '5 minutes'),
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cashier_payment_context_lookup_idx ON cashier_payment_context(work_order_id,consumed_at,expires_at,sequence_no);

CREATE TABLE IF NOT EXISTS work_order_payment_refunds(
  id bigserial PRIMARY KEY,
  payment_id uuid NOT NULL REFERENCES work_order_payments(id),
  work_order_id text NOT NULL,
  location_id text,
  finance_account_id uuid,
  cashier_shift_id bigint,
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  reason text NOT NULL,
  refund_method text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS work_order_payment_refunds_payment_idx ON work_order_payment_refunds(payment_id,created_at DESC);
CREATE INDEX IF NOT EXISTS work_order_payment_refunds_workorder_idx ON work_order_payment_refunds(work_order_id,created_at DESC);

CREATE OR REPLACE FUNCTION cashier_enrich_work_order_payment()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_location text;
  v_shift bigint;
  v_ctx cashier_payment_context%ROWTYPE;
BEGIN
  SELECT location_id::text INTO v_location FROM work_orders WHERE id=NEW.work_order_id;
  SELECT id INTO v_shift FROM cash_register_shifts WHERE location_id=v_location AND status='open' ORDER BY opened_at DESC LIMIT 1;
  IF NEW.payment_method='cash' AND v_shift IS NULL THEN
    RAISE EXCEPTION 'Készpénzes fizetés előtt nyissa meg a pénztári műszakot.' USING ERRCODE='P0001';
  END IF;
  NEW.cashier_shift_id:=COALESCE(NEW.cashier_shift_id,v_shift);
  SELECT * INTO v_ctx FROM cashier_payment_context
    WHERE work_order_id=NEW.work_order_id::text AND consumed_at IS NULL AND expires_at>now()
      AND base_method=NEW.payment_method AND abs(amount-NEW.amount)<0.01
    ORDER BY sequence_no,id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF v_ctx.id IS NOT NULL THEN
    NEW.payment_method_code:=COALESCE(NEW.payment_method_code,v_ctx.payment_method_code,NEW.payment_method);
    NEW.finance_account_id:=COALESCE(NEW.finance_account_id,v_ctx.finance_account_id);
    NEW.cashier_shift_id:=COALESCE(NEW.cashier_shift_id,v_ctx.cashier_shift_id);
    NEW.card_brand:=COALESCE(NEW.card_brand,v_ctx.card_brand);
    NEW.fee_amount:=COALESCE(NULLIF(NEW.fee_amount,0),v_ctx.fee_amount,0);
    UPDATE cashier_payment_context SET consumed_at=now() WHERE id=v_ctx.id;
  ELSE
    NEW.payment_method_code:=COALESCE(NEW.payment_method_code,NEW.payment_method);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_cashier_enrich_work_order_payment ON work_order_payments;
CREATE TRIGGER trg_cashier_enrich_work_order_payment
BEFORE INSERT ON work_order_payments
FOR EACH ROW EXECUTE FUNCTION cashier_enrich_work_order_payment();

INSERT INTO finance_payment_methods(location_id,code,name,method_type,sort_order) VALUES
(NULL,'cash','Készpénz','cash',10),
(NULL,'card','Bankkártya','card',20),
(NULL,'transfer','Átutalás','bank_transfer',30),
(NULL,'voucher','Utalvány','voucher',40),
(NULL,'online','Online bankkártya','online_card',50)
ON CONFLICT DO NOTHING;

COMMIT;
