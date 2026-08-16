BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Immutable, traceable money-movement ledger --------------------------------
ALTER TABLE financial_movements
  ADD COLUMN IF NOT EXISTS partner_id bigint,
  ADD COLUMN IF NOT EXISTS payment_method_id bigint,
  ADD COLUMN IF NOT EXISTS payment_method_code text,
  ADD COLUMN IF NOT EXISTS document_type_code text,
  ADD COLUMN IF NOT EXISTS document_id bigint,
  ADD COLUMN IF NOT EXISTS client_id text,
  ADD COLUMN IF NOT EXISTS employee_id text,
  ADD COLUMN IF NOT EXISTS service_id text,
  ADD COLUMN IF NOT EXISTS product_id text,
  ADD COLUMN IF NOT EXISTS visit_id text,
  ADD COLUMN IF NOT EXISTS work_order_id text,
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'posted',
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS fee_for_movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS reversal_of_id uuid,
  ADD COLUMN IF NOT EXISTS posting_group_id uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS integrity_version integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='financial_movements_reversal_of_fk') THEN
    ALTER TABLE financial_movements
      ADD CONSTRAINT financial_movements_reversal_of_fk
      FOREIGN KEY(reversal_of_id) REFERENCES financial_movements(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS financial_movements_one_reversal_uq
  ON financial_movements(reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS financial_movements_idempotency_uq
  ON financial_movements(COALESCE(location_id,'00000000-0000-0000-0000-000000000000'::uuid),idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS financial_movements_posting_group_idx
  ON financial_movements(posting_group_id) WHERE posting_group_id IS NOT NULL;

-- Configurable period close. A release is evidence, never a delete. ----------
CREATE TABLE IF NOT EXISTS finance_period_locks(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_key text NOT NULL,
  period_start date NOT NULL,
  period_end date NOT NULL,
  reason text NOT NULL,
  locked_by text NOT NULL,
  locked_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  released_by text,
  release_reason text,
  CONSTRAINT finance_period_locks_range_ck CHECK(period_start<=period_end),
  CONSTRAINT finance_period_locks_reason_ck CHECK(length(trim(reason))>=3),
  CONSTRAINT finance_period_locks_release_ck CHECK(
    (released_at IS NULL AND released_by IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND released_by IS NOT NULL AND length(trim(release_reason))>=3)
  )
);
CREATE INDEX IF NOT EXISTS finance_period_locks_active_idx
  ON finance_period_locks(location_key,period_start,period_end) WHERE released_at IS NULL;

CREATE TABLE IF NOT EXISTS finance_integrity_events(
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  location_key text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  actor text NOT NULL,
  reason text,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_integrity_events_subject_idx
  ON finance_integrity_events(subject_type,subject_id,created_at DESC);

-- Cross-ledger links and retry keys. Existing rows remain legacy-compatible;
-- every new protected write explicitly sets integrity_required=true.
ALTER TABLE financial_accounts
  ADD COLUMN IF NOT EXISTS allow_negative_balance boolean NOT NULL DEFAULT true;

-- Keep this integrity migration safe on partially upgraded installations and
-- isolated integration schemas. In the normal bootstrap these tables already
-- exist, so the declarations are no-ops.
CREATE TABLE IF NOT EXISTS financial_transfers(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  source_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  destination_account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  transferred_at timestamptz NOT NULL DEFAULT now(),
  note text,
  created_by text,
  source_movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  destination_movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_transfers_accounts_ck CHECK(source_account_id<>destination_account_id)
);

CREATE TABLE IF NOT EXISTS financial_refunds(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  work_order_id text,
  account_id uuid NOT NULL REFERENCES financial_accounts(id) ON DELETE RESTRICT,
  amount numeric(14,2) NOT NULL CHECK(amount>0),
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK(status IN('pending','completed','cancelled')),
  refunded_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  movement_id uuid REFERENCES financial_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounting_journal_entries(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  entry_date date NOT NULL,
  document_no text,
  source_type text NOT NULL,
  source_id text,
  description text,
  status text NOT NULL DEFAULT 'draft',
  created_by text,
  approved_by text,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS accounting_journal_lines(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id uuid NOT NULL REFERENCES accounting_journal_entries(id) ON DELETE CASCADE,
  account_code text NOT NULL,
  account_name text,
  debit numeric(14,2) NOT NULL DEFAULT 0 CHECK(debit>=0),
  credit numeric(14,2) NOT NULL DEFAULT 0 CHECK(credit>=0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(NOT(debit>0 AND credit>0))
);

ALTER TABLE financial_transfers ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS financial_transfers_idempotency_uq
  ON financial_transfers(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE financial_refunds ADD COLUMN IF NOT EXISTS idempotency_key text;
CREATE UNIQUE INDEX IF NOT EXISTS financial_refunds_idempotency_uq
  ON financial_refunds(idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE cash_register_movements
  ADD COLUMN IF NOT EXISTS financial_movement_id uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS integrity_required boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS cash_register_movements_idempotency_uq
  ON cash_register_movements(location_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE cash_register_closings
  ADD COLUMN IF NOT EXISTS cash_in numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_out numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE work_order_payment_refunds
  ADD COLUMN IF NOT EXISTS financial_movement_id uuid,
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS integrity_required boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS work_order_payment_refunds_idempotency_uq
  ON work_order_payment_refunds(payment_id,idempotency_key) WHERE idempotency_key IS NOT NULL;

ALTER TABLE work_order_payments
  ADD COLUMN IF NOT EXISTS finance_account_id uuid,
  ADD COLUMN IF NOT EXISTS financial_account_id uuid,
  ADD COLUMN IF NOT EXISTS financial_movement_id uuid,
  ADD COLUMN IF NOT EXISTS integrity_required boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS revenue_recognition text NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS settlement_key text,
  ADD COLUMN IF NOT EXISTS payment_sequence integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='work_order_payments_revenue_recognition_ck') THEN
    ALTER TABLE work_order_payments ADD CONSTRAINT work_order_payments_revenue_recognition_ck
      CHECK(revenue_recognition IN('legacy','ledger_income','voucher_redemption','prepaid_redemption')) NOT VALID;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS work_order_payments_settlement_sequence_uq
  ON work_order_payments(work_order_id,settlement_key,payment_sequence)
  WHERE settlement_key IS NOT NULL AND payment_sequence IS NOT NULL;

CREATE TABLE IF NOT EXISTS work_order_settlements(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id text NOT NULL,
  settlement_key text NOT NULL UNIQUE,
  request_payload jsonb NOT NULL,
  result_snapshot jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT work_order_settlements_completion_ck CHECK(
    (completed_at IS NULL AND result_snapshot IS NULL)
    OR (completed_at IS NOT NULL AND result_snapshot IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS work_order_settlements_order_idx
  ON work_order_settlements(work_order_id,created_at DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='cash_register_movements_financial_movement_fk') THEN
    ALTER TABLE cash_register_movements ADD CONSTRAINT cash_register_movements_financial_movement_fk
      FOREIGN KEY(financial_movement_id) REFERENCES financial_movements(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='work_order_payment_refunds_financial_movement_fk') THEN
    ALTER TABLE work_order_payment_refunds ADD CONSTRAINT work_order_payment_refunds_financial_movement_fk
      FOREIGN KEY(financial_movement_id) REFERENCES financial_movements(id) ON DELETE RESTRICT NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='work_order_payments_financial_movement_integrity_fk') THEN
    ALTER TABLE work_order_payments ADD CONSTRAINT work_order_payments_financial_movement_integrity_fk
      FOREIGN KEY(financial_movement_id) REFERENCES financial_movements(id) ON DELETE RESTRICT NOT VALID;
  END IF;
END $$;

-- The ledger may only be corrected by a linked, exact reversal. --------------
CREATE OR REPLACE FUNCTION finance_guard_movement_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_original financial_movements%ROWTYPE;
  v_allow_negative boolean;
  v_balance numeric;
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'A pénzügyi főkönyvből fizikai törlés nem engedélyezett.' USING ERRCODE='P0001';
  END IF;

  IF TG_OP='UPDATE' THEN
    IF ROW(NEW.location_id,NEW.account_id,NEW.category_id,NEW.direction,NEW.amount,NEW.occurred_at,
           NEW.reference_type,NEW.reference_id,NEW.counterparty,NEW.note,NEW.created_by,
           NEW.partner_id,NEW.payment_method_id,NEW.payment_method_code,NEW.document_type_code,
           NEW.document_id,NEW.client_id,NEW.employee_id,NEW.service_id,NEW.product_id,NEW.visit_id,
           NEW.work_order_id,NEW.fee_for_movement_id,NEW.reversal_of_id,NEW.posting_group_id,
           NEW.idempotency_key,NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.location_id,OLD.account_id,OLD.category_id,OLD.direction,OLD.amount,OLD.occurred_at,
           OLD.reference_type,OLD.reference_id,OLD.counterparty,OLD.note,OLD.created_by,
           OLD.partner_id,OLD.payment_method_id,OLD.payment_method_code,OLD.document_type_code,
           OLD.document_id,OLD.client_id,OLD.employee_id,OLD.service_id,OLD.product_id,OLD.visit_id,
           OLD.work_order_id,OLD.fee_for_movement_id,OLD.reversal_of_id,OLD.posting_group_id,
           OLD.idempotency_key,OLD.created_at) THEN
      RAISE EXCEPTION 'A könyvelt pénzügyi tétel tartalma nem módosítható; készítsen ellenkönyvelést.' USING ERRCODE='P0001';
    END IF;
    IF OLD.cancelled_at IS NOT NULL AND ROW(NEW.cancelled_at,NEW.cancelled_by,NEW.reversed_by_id)
       IS DISTINCT FROM ROW(OLD.cancelled_at,OLD.cancelled_by,OLD.reversed_by_id) THEN
      RAISE EXCEPTION 'A sztornókapcsolat utólag nem módosítható.' USING ERRCODE='P0001';
    END IF;
    IF OLD.cancelled_at IS NULL AND NEW.cancelled_at IS NOT NULL THEN
      IF NEW.reversed_by_id IS NULL OR NOT EXISTS(
        SELECT 1 FROM financial_movements r
        WHERE r.id=NEW.reversed_by_id AND r.reversal_of_id=OLD.id
      ) THEN
        RAISE EXCEPTION 'Sztornó csak pontosan kapcsolt ellenkönyvelési tétellel lehetséges.' USING ERRCODE='P0001';
      END IF;
      IF NEW.payment_status<>'cancelled' OR NEW.cancelled_by IS NULL
         OR length(trim(COALESCE(NEW.cancellation_reason,'')))<3 THEN
        RAISE EXCEPTION 'A sztornó státusza, végrehajtója és indoka kötelező.' USING ERRCODE='P0001';
      END IF;
    ELSIF ROW(NEW.payment_status,NEW.cancelled_at,NEW.cancelled_by,NEW.cancellation_reason,NEW.reversed_by_id)
       IS DISTINCT FROM ROW(OLD.payment_status,OLD.cancelled_at,OLD.cancelled_by,OLD.cancellation_reason,OLD.reversed_by_id) THEN
      RAISE EXCEPTION 'A könyvelési státusz csak pontos ellenkönyveléssel módosítható.' USING ERRCODE='P0001';
    END IF;
    RETURN NEW;
  END IF;

  IF EXISTS(
    SELECT 1 FROM finance_period_locks l
    WHERE l.released_at IS NULL
      AND (l.location_key='__global__' OR l.location_key=COALESCE(NEW.location_id::text,'__global__'))
      AND NEW.occurred_at::date BETWEEN l.period_start AND l.period_end
  ) THEN
    RAISE EXCEPTION 'A pénzügyi időszak lezárt; erre a dátumra új tétel nem könyvelhető.' USING ERRCODE='P0001';
  END IF;

  IF NEW.reversal_of_id IS NOT NULL THEN
    SELECT * INTO v_original FROM financial_movements WHERE id=NEW.reversal_of_id FOR UPDATE;
    IF v_original.id IS NULL THEN
      RAISE EXCEPTION 'A sztornó eredeti tétele nem található.' USING ERRCODE='23503';
    END IF;
    IF v_original.reversal_of_id IS NOT NULL OR v_original.reversed_by_id IS NOT NULL THEN
      RAISE EXCEPTION 'Sztornótétel nem sztornózható, és egy tétel csak egyszer sztornózható.' USING ERRCODE='P0001';
    END IF;
    IF NEW.account_id<>v_original.account_id OR NEW.amount<>v_original.amount
       OR NEW.direction= v_original.direction
       OR COALESCE(NEW.location_id::text,'')<>COALESCE(v_original.location_id::text,'')
       OR NEW.payment_status<>'reversal' THEN
      RAISE EXCEPTION 'A sztornó nem az eredeti tétel pontos, ellenkező irányú párja.' USING ERRCODE='P0001';
    END IF;
  END IF;

  SELECT COALESCE(allow_negative_balance,true),opening_balance
    INTO v_allow_negative,v_balance
    FROM financial_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF NEW.direction='expense' AND NOT v_allow_negative THEN
    SELECT COALESCE(v_balance,0)+COALESCE(SUM(CASE WHEN direction='income' THEN amount ELSE -amount END),0)-NEW.amount
      INTO v_balance FROM financial_movements WHERE account_id=NEW.account_id;
    IF v_balance < 0 THEN
      RAISE EXCEPTION 'A könyvelés nem engedélyezett: a pénzügyi számla egyenlege negatívvá válna.' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_finance_guard_movement_write ON financial_movements;
CREATE TRIGGER trg_finance_guard_movement_write
BEFORE INSERT OR UPDATE OR DELETE ON financial_movements
FOR EACH ROW EXECUTE FUNCTION finance_guard_movement_write();

-- Cash-register evidence and the ledger must describe the same fact. --------
CREATE OR REPLACE FUNCTION finance_assert_cash_ledger_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_movement financial_movements%ROWTYPE; v_location text; v_date date;
BEGIN
  v_location:=NEW.location_id;
  v_date:=NEW.business_date;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_location||':'||v_date::text,0));
  IF TG_OP='INSERT' AND EXISTS(
    SELECT 1 FROM cash_register_closings
    WHERE location_id=v_location AND business_date=v_date
  ) THEN
    RAISE EXCEPTION 'A lezárt napi pénztárhoz új pénzmozgás nem rögzíthető.' USING ERRCODE='P0001';
  END IF;
  IF TG_OP='UPDATE' AND OLD.voided_at IS NULL AND NEW.voided_at IS NOT NULL AND EXISTS(
    SELECT 1 FROM cash_register_closings
    WHERE location_id=v_location AND business_date=v_date
  ) THEN
    RAISE EXCEPTION 'Lezárt napi pénztár tétele nem vonható vissza.' USING ERRCODE='P0001';
  END IF;
  IF NEW.integrity_required THEN
    IF NEW.financial_movement_id IS NULL THEN
      RAISE EXCEPTION 'A kasszatétel pénzügyi főkönyvi hivatkozása kötelező.' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO v_movement FROM financial_movements WHERE id=NEW.financial_movement_id;
    IF v_movement.id IS NULL OR v_movement.amount<>NEW.amount
       OR v_movement.direction<>(CASE WHEN NEW.direction='in' THEN 'income' ELSE 'expense' END)
       OR v_movement.account_id IS DISTINCT FROM NEW.finance_account_id
       OR COALESCE(v_movement.location_id::text,'')<>COALESCE(NEW.location_id,'') THEN
      RAISE EXCEPTION 'A kasszatétel és a főkönyvi tétel nem egyezik.' USING ERRCODE='P0001';
    END IF;
    IF NEW.voided_at IS NOT NULL AND v_movement.reversed_by_id IS NULL THEN
      RAISE EXCEPTION 'Kasszatétel csak főkönyvi ellenkönyveléssel vonható vissza.' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_finance_cash_ledger_link ON cash_register_movements;
CREATE TRIGGER trg_finance_cash_ledger_link
BEFORE INSERT OR UPDATE ON cash_register_movements
FOR EACH ROW EXECUTE FUNCTION finance_assert_cash_ledger_link();

CREATE OR REPLACE FUNCTION finance_assert_refund_ledger_link()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_movement financial_movements%ROWTYPE;
BEGIN
  IF NEW.integrity_required THEN
    IF NEW.financial_movement_id IS NULL THEN
      RAISE EXCEPTION 'A visszatérítés pénzügyi főkönyvi hivatkozása kötelező.' USING ERRCODE='P0001';
    END IF;
    SELECT * INTO v_movement FROM financial_movements WHERE id=NEW.financial_movement_id;
    IF v_movement.id IS NULL OR v_movement.direction<>'expense' OR v_movement.amount<>NEW.amount
       OR v_movement.account_id IS DISTINCT FROM NEW.finance_account_id
       OR COALESCE(v_movement.location_id::text,'')<>COALESCE(NEW.location_id,'') THEN
      RAISE EXCEPTION 'A visszatérítés és a főkönyvi kiadás nem egyezik.' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_finance_refund_ledger_link ON work_order_payment_refunds;
CREATE TRIGGER trg_finance_refund_ledger_link
BEFORE INSERT OR UPDATE ON work_order_payment_refunds
FOR EACH ROW EXECUTE FUNCTION finance_assert_refund_ledger_link();

-- Daily close and payments use the same advisory lock, preventing stale close
-- snapshots and writes racing behind a close operation.
CREATE OR REPLACE FUNCTION finance_guard_cash_close()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_in numeric; v_out numeric; v_pay record; v_orders record;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(COALESCE(NEW.location_id,'__global__')||':'||NEW.business_date::text,0));
  SELECT COALESCE(SUM(amount) FILTER(WHERE direction='in' AND voided_at IS NULL),0),
         COALESCE(SUM(amount) FILTER(WHERE direction='out' AND voided_at IS NULL),0)
    INTO v_in,v_out FROM cash_register_movements
    WHERE location_id IS NOT DISTINCT FROM NEW.location_id AND business_date=NEW.business_date;
  SELECT
    COALESCE(SUM(CASE WHEN wp.payment_method='cash' THEN wp.amount ELSE 0 END),0) cash_sales,
    COALESCE(SUM(CASE WHEN wp.payment_method='card' THEN wp.amount ELSE 0 END),0) card_sales,
    COALESCE(SUM(CASE WHEN wp.payment_method='transfer' THEN wp.amount ELSE 0 END),0) transfer_sales,
    COALESCE(SUM(CASE WHEN wp.payment_method='voucher' THEN wp.amount ELSE 0 END),0) voucher_sales,
    COALESCE(SUM(CASE WHEN wp.payment_method='other' THEN wp.amount ELSE 0 END),0) other_sales
    INTO v_pay FROM work_order_payments wp JOIN work_orders wo ON wo.id=wp.work_order_id
    WHERE wp.paid_at::date=NEW.business_date
      AND wo.location_id::text IS NOT DISTINCT FROM NEW.location_id;
  SELECT COALESCE(SUM(tip_amount),0) tips,COALESCE(SUM(discount_amount),0) discounts
    INTO v_orders FROM work_orders
    WHERE financial_closed_at::date=NEW.business_date
      AND location_id::text IS NOT DISTINCT FROM NEW.location_id;
  NEW.cash_in:=v_in;
  NEW.cash_out:=v_out;
  NEW.cash_sales:=v_pay.cash_sales;
  NEW.card_sales:=v_pay.card_sales;
  NEW.transfer_sales:=v_pay.transfer_sales;
  NEW.voucher_sales:=v_pay.voucher_sales;
  NEW.other_sales:=v_pay.other_sales;
  NEW.tips:=v_orders.tips;
  NEW.discounts:=v_orders.discounts;
  NEW.expected_cash:=NEW.opening_cash+NEW.cash_sales+v_in-v_out;
  NEW.difference:=NEW.counted_cash-NEW.expected_cash;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_finance_guard_cash_close ON cash_register_closings;
CREATE TRIGGER trg_finance_guard_cash_close
BEFORE INSERT OR UPDATE ON cash_register_closings
FOR EACH ROW EXECUTE FUNCTION finance_guard_cash_close();

CREATE OR REPLACE FUNCTION finance_guard_work_order_payment_day()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_location text; v_date date;
BEGIN
  SELECT location_id::text INTO v_location FROM work_orders WHERE id=NEW.work_order_id;
  v_date:=COALESCE(NEW.paid_at,now())::date;
  IF v_location IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(v_location||':'||v_date::text,0));
    IF EXISTS(SELECT 1 FROM cash_register_closings WHERE location_id=v_location AND business_date=v_date) THEN
      RAISE EXCEPTION 'A lezárt üzleti naphoz fizetés nem rögzíthető vagy módosítható.' USING ERRCODE='P0001';
    END IF;
    IF EXISTS(SELECT 1 FROM finance_period_locks WHERE released_at IS NULL AND (location_key='__global__' OR location_key=v_location) AND v_date BETWEEN period_start AND period_end) THEN
      RAISE EXCEPTION 'A lezárt pénzügyi időszakhoz fizetés nem rögzíthető vagy módosítható.' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_finance_guard_work_order_payment_day ON work_order_payments;
CREATE TRIGGER trg_finance_guard_work_order_payment_day
BEFORE INSERT OR UPDATE ON work_order_payments
FOR EACH ROW EXECUTE FUNCTION finance_guard_work_order_payment_day();

CREATE OR REPLACE FUNCTION finance_assert_work_order_payment_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_payment work_order_payments%ROWTYPE; v_movement financial_movements%ROWTYPE; v_location text; v_account uuid;
BEGIN
  SELECT * INTO v_payment FROM work_order_payments WHERE id=NEW.id;
  IF v_payment.settlement_key IS NULL THEN RETURN NEW; END IF;
  SELECT location_id::text INTO v_location FROM work_orders WHERE id=v_payment.work_order_id;
  v_account:=COALESCE(v_payment.finance_account_id,v_payment.financial_account_id);
  IF NOT v_payment.integrity_required THEN
    RAISE EXCEPTION 'A munkalapfizetés pénzügyi integritási jelölése kötelező.' USING ERRCODE='P0001';
  END IF;
  IF v_payment.revenue_recognition='voucher_redemption' THEN
    IF v_payment.payment_method<>'voucher' OR v_payment.financial_movement_id IS NOT NULL THEN
      RAISE EXCEPTION 'Az utalványbeváltás nem könyvelhető új bevételként.' USING ERRCODE='P0001';
    END IF;
  ELSIF v_payment.revenue_recognition='prepaid_redemption' THEN
    IF v_payment.financial_movement_id IS NOT NULL OR lower(COALESCE(v_payment.note,'')) NOT LIKE '%wallet%' THEN
      RAISE EXCEPTION 'Az előre feltöltött vendégegyenleg felhasználása nem könyvelhető új bevételként.' USING ERRCODE='P0001';
    END IF;
  ELSIF v_payment.revenue_recognition='ledger_income' THEN
    SELECT * INTO v_movement FROM financial_movements WHERE id=v_payment.financial_movement_id;
    IF v_movement.id IS NULL OR v_account IS NULL OR v_movement.account_id<>v_account
       OR v_movement.direction<>'income' OR v_movement.amount<>v_payment.amount
       OR v_movement.reference_type<>'work_order_payment' OR v_movement.reference_id<>v_payment.id::text
       OR COALESCE(v_movement.location_id::text,'')<>COALESCE(v_location,'') THEN
      RAISE EXCEPTION 'A munkalapfizetéshez hiányzó vagy eltérő bevételi főkönyvi tétel tartozik.' USING ERRCODE='P0001';
    END IF;
  ELSE
    RAISE EXCEPTION 'A munkalapfizetés bevételelszámolási módja érvénytelen.' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_finance_work_order_payment_ledger ON work_order_payments;
CREATE CONSTRAINT TRIGGER trg_finance_work_order_payment_ledger
AFTER INSERT OR UPDATE ON work_order_payments DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance_assert_work_order_payment_ledger();

-- A transfer is accepted only if both ledger legs exist and exactly balance. --
CREATE OR REPLACE FUNCTION finance_assert_transfer_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_source financial_movements%ROWTYPE; v_destination financial_movements%ROWTYPE;
BEGIN
  SELECT * INTO v_source FROM financial_movements WHERE id=NEW.source_movement_id;
  SELECT * INTO v_destination FROM financial_movements WHERE id=NEW.destination_movement_id;
  IF v_source.id IS NULL OR v_destination.id IS NULL
     OR v_source.account_id<>NEW.source_account_id OR v_destination.account_id<>NEW.destination_account_id
     OR v_source.direction<>'expense' OR v_destination.direction<>'income'
     OR v_source.amount<>NEW.amount OR v_destination.amount<>NEW.amount THEN
    RAISE EXCEPTION 'Az átvezetés két könyvelési lába hiányzik vagy nem egyezik.' USING ERRCODE='P0001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_finance_assert_transfer_balanced ON financial_transfers;
CREATE CONSTRAINT TRIGGER trg_finance_assert_transfer_balanced
AFTER INSERT OR UPDATE ON financial_transfers DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance_assert_transfer_balanced();

-- Posted accounting journals must balance to the cent at commit. -------------
CREATE OR REPLACE FUNCTION finance_assert_journal_balanced()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_status text; v_delta numeric; v_line_count integer;
BEGIN
  v_id:=COALESCE(
    NULLIF(to_jsonb(NEW)->>'journal_entry_id','')::uuid,
    NULLIF(to_jsonb(OLD)->>'journal_entry_id','')::uuid,
    NULLIF(to_jsonb(NEW)->>'id','')::uuid,
    NULLIF(to_jsonb(OLD)->>'id','')::uuid
  );
  SELECT status INTO v_status FROM accounting_journal_entries WHERE id=v_id;
  IF v_status='posted' THEN
    SELECT COALESCE(SUM(debit-credit),0),COUNT(*) INTO v_delta,v_line_count
      FROM accounting_journal_lines WHERE journal_entry_id=v_id;
    IF v_line_count=0 OR abs(v_delta)>0.009 THEN
      RAISE EXCEPTION 'A főkönyvi bizonylat üres vagy nem kiegyenlített (tartozik <> követel).' USING ERRCODE='P0001';
    END IF;
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS trg_finance_journal_lines_balanced ON accounting_journal_lines;
CREATE CONSTRAINT TRIGGER trg_finance_journal_lines_balanced
AFTER INSERT OR UPDATE OR DELETE ON accounting_journal_lines DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance_assert_journal_balanced();

CREATE OR REPLACE FUNCTION finance_guard_posted_journal_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_status text;
BEGIN
  v_id:=COALESCE(
    NULLIF(to_jsonb(OLD)->>'journal_entry_id','')::uuid,
    NULLIF(to_jsonb(OLD)->>'id','')::uuid
  );
  IF TG_TABLE_NAME='accounting_journal_entries' THEN
    v_status:=OLD.status;
  ELSE
    SELECT status INTO v_status FROM accounting_journal_entries WHERE id=v_id;
  END IF;
  IF v_status='posted' THEN
    RAISE EXCEPTION 'A feladott főkönyvi bizonylat nem módosítható vagy törölhető; ellenbizonylat szükséges.' USING ERRCODE='P0001';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS trg_finance_guard_posted_journal_lines ON accounting_journal_lines;
CREATE TRIGGER trg_finance_guard_posted_journal_lines
BEFORE UPDATE OR DELETE ON accounting_journal_lines
FOR EACH ROW EXECUTE FUNCTION finance_guard_posted_journal_mutation();
DROP TRIGGER IF EXISTS trg_finance_guard_posted_journal_entries ON accounting_journal_entries;
CREATE TRIGGER trg_finance_guard_posted_journal_entries
BEFORE UPDATE OR DELETE ON accounting_journal_entries
FOR EACH ROW EXECUTE FUNCTION finance_guard_posted_journal_mutation();
DROP TRIGGER IF EXISTS trg_finance_journal_entry_balanced ON accounting_journal_entries;
CREATE CONSTRAINT TRIGGER trg_finance_journal_entry_balanced
AFTER INSERT OR UPDATE ON accounting_journal_entries DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION finance_assert_journal_balanced();

CREATE OR REPLACE FUNCTION finance_block_evidence_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Pénzügyi bizonyíték fizikailag nem törölhető.' USING ERRCODE='P0001';
  END IF;
  IF TG_TABLE_NAME='finance_integrity_events' AND TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'A pénzügyi integritási esemény nem módosítható.' USING ERRCODE='P0001';
  END IF;
  RETURN COALESCE(NEW,OLD);
END $$;

DROP TRIGGER IF EXISTS trg_finance_no_delete_transfers ON financial_transfers;
CREATE TRIGGER trg_finance_no_delete_transfers BEFORE DELETE ON financial_transfers FOR EACH ROW EXECUTE FUNCTION finance_block_evidence_delete();
DROP TRIGGER IF EXISTS trg_finance_no_delete_refunds ON financial_refunds;
CREATE TRIGGER trg_finance_no_delete_refunds BEFORE DELETE ON financial_refunds FOR EACH ROW EXECUTE FUNCTION finance_block_evidence_delete();
DROP TRIGGER IF EXISTS trg_finance_no_delete_payment_refunds ON work_order_payment_refunds;
CREATE TRIGGER trg_finance_no_delete_payment_refunds BEFORE DELETE ON work_order_payment_refunds FOR EACH ROW EXECUTE FUNCTION finance_block_evidence_delete();
DROP TRIGGER IF EXISTS trg_finance_no_delete_cash ON cash_register_movements;
CREATE TRIGGER trg_finance_no_delete_cash BEFORE DELETE ON cash_register_movements FOR EACH ROW EXECUTE FUNCTION finance_block_evidence_delete();
DROP TRIGGER IF EXISTS trg_finance_no_delete_settlements ON work_order_settlements;
CREATE TRIGGER trg_finance_no_delete_settlements BEFORE DELETE ON work_order_settlements FOR EACH ROW EXECUTE FUNCTION finance_block_evidence_delete();
DROP TRIGGER IF EXISTS trg_finance_integrity_events_immutable ON finance_integrity_events;
CREATE TRIGGER trg_finance_integrity_events_immutable BEFORE UPDATE OR DELETE ON finance_integrity_events FOR EACH ROW EXECUTE FUNCTION finance_block_evidence_delete();

COMMIT;
