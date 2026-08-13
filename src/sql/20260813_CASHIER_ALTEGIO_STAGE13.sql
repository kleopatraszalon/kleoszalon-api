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

ALTER TABLE cash_register_closings
  ADD COLUMN IF NOT EXISTS register_id bigint;
ALTER TABLE cash_register_closings DROP CONSTRAINT IF EXISTS cash_register_closings_location_id_business_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_register_closings_register_date
  ON cash_register_closings(register_id,business_date) WHERE register_id IS NOT NULL;

ALTER TABLE cash_movements
  ADD COLUMN IF NOT EXISTS register_id bigint,
  ADD COLUMN IF NOT EXISTS movement_type varchar(30) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS reference_no text,
  ADD COLUMN IF NOT EXISTS partner_id bigint,
  ADD COLUMN IF NOT EXISTS employee_id text,
  ADD COLUMN IF NOT EXISTS work_order_id text,
  ADD COLUMN IF NOT EXISTS payment_id uuid,
  ADD COLUMN IF NOT EXISTS transfer_id bigint;

ALTER TABLE work_order_payments
  ADD COLUMN IF NOT EXISTS register_id bigint,
  ADD COLUMN IF NOT EXISTS register_session_id bigint,
  ADD COLUMN IF NOT EXISTS payment_method_code text,
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
  payment_id uuid NOT NULL REFERENCES work_order_payments(id),
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

CREATE TABLE IF NOT EXISTS cashier_checkout_context(
  work_order_id text PRIMARY KEY,
  location_id text NOT NULL,
  register_id bigint NOT NULL REFERENCES cash_registers(id),
  register_session_id bigint NOT NULL REFERENCES cash_register_sessions(id),
  created_by text,
  expires_at timestamptz NOT NULL DEFAULT (now()+interval '5 minutes'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION enforce_cash_payment_open_register()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_location text;
  v_count integer;
  v_register bigint;
  v_session bigint;
BEGIN
  IF NEW.payment_method <> 'cash' THEN
    RETURN NEW;
  END IF;

  IF NEW.register_session_id IS NOT NULL THEN
    SELECT s.register_id INTO v_register
    FROM cash_register_sessions s
    WHERE s.id=NEW.register_session_id AND s.status='open';
    IF v_register IS NULL THEN
      RAISE EXCEPTION 'A kiválasztott készpénztár nincs megnyitva.' USING ERRCODE='P0001';
    END IF;
    NEW.register_id:=COALESCE(NEW.register_id,v_register);
    RETURN NEW;
  END IF;

  SELECT wo.location_id::text INTO v_location FROM work_orders wo WHERE wo.id=NEW.work_order_id;

  IF NEW.register_id IS NOT NULL THEN
    SELECT s.id INTO v_session FROM cash_register_sessions s
    WHERE s.register_id=NEW.register_id AND s.status='open' LIMIT 1;
    IF v_session IS NULL THEN
      RAISE EXCEPTION 'A kiválasztott készpénztár nincs megnyitva.' USING ERRCODE='P0001';
    END IF;
    NEW.register_session_id:=v_session;
    RETURN NEW;
  END IF;

  SELECT c.register_id,c.register_session_id INTO v_register,v_session
  FROM cashier_checkout_context c
  WHERE c.work_order_id=NEW.work_order_id::text AND c.expires_at>now()
  ORDER BY c.created_at DESC LIMIT 1;
  IF v_session IS NOT NULL THEN
    NEW.register_id:=v_register;
    NEW.register_session_id:=v_session;
    RETURN NEW;
  END IF;

  SELECT count(*),min(s.register_id),min(s.id)
    INTO v_count,v_register,v_session
  FROM cash_register_sessions s
  WHERE s.location_id=v_location AND s.status='open';
  IF v_count=0 THEN
    RAISE EXCEPTION 'Készpénzes fizetés előtt nyissa meg a pénztárt.' USING ERRCODE='P0001';
  ELSIF v_count>1 THEN
    RAISE EXCEPTION 'Több nyitott pénztár van. Válassza ki a készpénztárt.' USING ERRCODE='P0001';
  END IF;
  NEW.register_id:=v_register;
  NEW.register_session_id:=v_session;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_order_cash_payment_register ON work_order_payments;
CREATE TRIGGER trg_work_order_cash_payment_register
BEFORE INSERT ON work_order_payments
FOR EACH ROW EXECUTE FUNCTION enforce_cash_payment_open_register();

COMMIT;
