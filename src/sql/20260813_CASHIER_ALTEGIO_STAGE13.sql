BEGIN;

ALTER TABLE cash_registers
  ADD COLUMN IF NOT EXISTS register_type varchar(20) NOT NULL DEFAULT 'cash',
  ADD COLUMN IF NOT EXISTS opening_balance numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS comment text,
  ADD COLUMN IF NOT EXISTS external_code text,
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS financial_account_id uuid;

ALTER TABLE cash_registers DROP CONSTRAINT IF EXISTS cash_registers_location_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_registers_location_name
  ON cash_registers(location_id, lower(name));

ALTER TABLE cash_register_sessions
  ADD COLUMN IF NOT EXISTS shift_no integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS handover_from_session_id bigint,
  ADD COLUMN IF NOT EXISTS handed_to text;

ALTER TABLE cash_register_sessions DROP CONSTRAINT IF EXISTS cash_register_sessions_location_id_business_date_key;
CREATE INDEX IF NOT EXISTS cash_register_sessions_register_date_idx
  ON cash_register_sessions(register_id,business_date,opened_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_register_one_open_session
  ON cash_register_sessions(register_id) WHERE status='open';

ALTER TABLE cash_movements
  ADD COLUMN IF NOT EXISTS movement_type varchar(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS reference_no text,
  ADD COLUMN IF NOT EXISTS partner_id bigint,
  ADD COLUMN IF NOT EXISTS employee_id text,
  ADD COLUMN IF NOT EXISTS work_order_id text,
  ADD COLUMN IF NOT EXISTS payment_id bigint,
  ADD COLUMN IF NOT EXISTS transfer_id bigint;

ALTER TABLE work_order_payments
  ADD COLUMN IF NOT EXISTS register_id bigint,
  ADD COLUMN IF NOT EXISTS register_session_id bigint,
  ADD COLUMN IF NOT EXISTS refunded_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS card_brand text,
  ADD COLUMN IF NOT EXISTS fee_amount numeric(14,2) NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS cash_register_counts(
  id bigserial PRIMARY KEY,
  register_id bigint NOT NULL REFERENCES cash_registers(id),
  session_id bigint NOT NULL REFERENCES cash_register_sessions(id),
  location_id text NOT NULL,
  business_date date NOT NULL,
  count_type varchar(20) NOT NULL,
  denominations jsonb NOT NULL DEFAULT '{}'::jsonb,
  counted_cash numeric(14,2) NOT NULL DEFAULT 0,
  expected_cash numeric(14,2) NOT NULL DEFAULT 0,
  difference numeric(14,2) NOT NULL DEFAULT 0,
  note text,
  handed_to text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_register_counts_type_check CHECK(count_type IN('opening','check','handover','closing'))
);
CREATE INDEX IF NOT EXISTS cash_register_counts_session_idx ON cash_register_counts(session_id,created_at DESC);

CREATE TABLE IF NOT EXISTS cash_register_transfers(
  id bigserial PRIMARY KEY,
  location_id text NOT NULL,
  from_register_id bigint NOT NULL REFERENCES cash_registers(id),
  to_register_id bigint NOT NULL REFERENCES cash_registers(id),
  amount numeric(14,2) NOT NULL,
  reference_no text,
  note text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_register_transfer_amount_check CHECK(amount>0),
  CONSTRAINT cash_register_transfer_distinct_check CHECK(from_register_id<>to_register_id)
);

CREATE TABLE IF NOT EXISTS work_order_payment_refunds(
  id bigserial PRIMARY KEY,
  payment_id bigint NOT NULL REFERENCES work_order_payments(id),
  work_order_id text NOT NULL,
  location_id text,
  register_id bigint,
  register_session_id bigint,
  amount numeric(14,2) NOT NULL,
  reason text NOT NULL,
  refund_method varchar(20) NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_order_refund_amount_check CHECK(amount>0)
);
CREATE INDEX IF NOT EXISTS work_order_payment_refunds_payment_idx ON work_order_payment_refunds(payment_id,created_at DESC);
CREATE INDEX IF NOT EXISTS work_order_payment_refunds_workorder_idx ON work_order_payment_refunds(work_order_id,created_at DESC);

COMMIT;
