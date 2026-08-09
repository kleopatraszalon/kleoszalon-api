-- Munkalap workflow v2 – PDF specifikáció szerinti dokumentum-életciklus
-- Piszkozat -> Nyitott/Mentett -> Lezárt, külön Visszavont állapottal.
-- A meglévő status mező továbbra is a vendég/szolgáltatás életciklusát kezeli.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS document_status text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS arrival_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_started_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS work_finished_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS closed_by uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancelled_by uuid;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS cancellation_note text;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS base_discount_percent numeric(7,3) NOT NULL DEFAULT 0;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS applied_discount_percent numeric(7,3) NOT NULL DEFAULT 0;
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS customer_balance_snapshot numeric(14,2);
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS total_gross numeric(14,2);
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS paid_total numeric(14,2);
ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS amount_due numeric(14,2);

UPDATE work_orders
SET document_status = CASE
  WHEN status='completed' THEN 'completed'
  WHEN status IN ('cancelled','no_show') THEN 'cancelled'
  WHEN status='in_progress' THEN 'open'
  ELSE 'draft'
END
WHERE document_status IS NULL;

ALTER TABLE work_orders ALTER COLUMN document_status SET DEFAULT 'draft';
ALTER TABLE work_orders ALTER COLUMN document_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='work_orders_document_status_chk'
  ) THEN
    ALTER TABLE work_orders
      ADD CONSTRAINT work_orders_document_status_chk
      CHECK (document_status IN ('draft','open','completed','cancelled'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS work_orders_document_status_idx
  ON work_orders(document_status, created_at DESC);

CREATE TABLE IF NOT EXISTS work_order_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
  status_kind text NOT NULL CHECK (status_kind IN ('document','service')),
  from_status text,
  to_status text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changed_by uuid,
  reason text,
  note text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS work_order_status_history_workorder_idx
  ON work_order_status_history(work_order_id, changed_at DESC);

-- Egyszeri kezdő history sor a meglévő rekordokhoz.
INSERT INTO work_order_status_history(work_order_id,status_kind,from_status,to_status,changed_at,reason)
SELECT w.id,'document',NULL,w.document_status,COALESCE(w.created_at,now()),'MIGRATION_INITIAL_STATE'
FROM work_orders w
WHERE NOT EXISTS (
  SELECT 1 FROM work_order_status_history h
  WHERE h.work_order_id=w.id AND h.status_kind='document'
);

-- A dokumentum-életciklus megengedett átmenetei:
-- draft -> open | cancelled
-- open -> completed | cancelled
-- completed/cancelled terminális
CREATE OR REPLACE FUNCTION validate_work_order_document_status()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.document_status IS DISTINCT FROM NEW.document_status THEN
    IF OLD.locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'A(z) % munkalap lezárt és archivált; nem módosítható.',OLD.work_order_number USING ERRCODE='55000';
    END IF;
    IF OLD.document_status='draft' AND NEW.document_status NOT IN ('open','cancelled') THEN
      RAISE EXCEPTION 'Nem engedélyezett munkalap dokumentumállapot: % -> %',OLD.document_status,NEW.document_status USING ERRCODE='23514';
    ELSIF OLD.document_status='open' AND NEW.document_status NOT IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'Nem engedélyezett munkalap dokumentumállapot: % -> %',OLD.document_status,NEW.document_status USING ERRCODE='23514';
    ELSIF OLD.document_status IN ('completed','cancelled') THEN
      RAISE EXCEPTION 'A lezárt vagy visszavont munkalap állapota nem változtatható.' USING ERRCODE='55000';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_work_orders_document_status_guard ON work_orders;
CREATE TRIGGER trg_work_orders_document_status_guard
BEFORE UPDATE OF document_status ON work_orders
FOR EACH ROW EXECUTE FUNCTION validate_work_order_document_status();
