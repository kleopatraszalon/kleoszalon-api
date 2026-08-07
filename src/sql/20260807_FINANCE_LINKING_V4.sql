BEGIN;

-- Kompatibilitási réteg a meglévő work_orders táblához.
ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS invoice_status text NOT NULL DEFAULT 'not_requested',
  ADD COLUMN IF NOT EXISTS financial_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS financial_closed_by text,
  ADD COLUMN IF NOT EXISTS amount_due numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gross_total numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tip_amount numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS client_name text;

CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_workorder_unique_uq
ON finance_invoices(work_order_id)
WHERE direction='outgoing' AND work_order_id IS NOT NULL AND status <> 'cancelled';

CREATE UNIQUE INDEX IF NOT EXISTS finance_invoices_purchase_order_unique_uq
ON finance_invoices(purchase_order_id)
WHERE direction='incoming' AND purchase_order_id IS NOT NULL AND status <> 'cancelled';

CREATE OR REPLACE FUNCTION vir_sync_outgoing_invoice_from_work_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_total numeric(14,2);
  v_invoice_status text;
BEGIN
  IF NEW.financial_closed_at IS NULL OR COALESCE(NEW.invoice_status,'not_requested') NOT IN ('requested','issued') THEN
    RETURN NEW;
  END IF;

  v_total := GREATEST(COALESCE(NEW.amount_due, NEW.gross_total, 0), 0);
  v_invoice_status := CASE WHEN NEW.invoice_status='issued' THEN 'approved' ELSE 'draft' END;

  INSERT INTO finance_invoices(
    location_id,direction,invoice_no,partner_name,issue_date,performance_date,due_date,
    currency,net_total,vat_total,gross_total,status,work_order_id,note,created_by,created_at,updated_at
  ) VALUES (
    NEW.location_id,'outgoing',
    CASE WHEN NEW.invoice_status='issued' THEN 'VIR-WO-' || NEW.id::text ELSE NULL END,
    COALESCE(NULLIF(NEW.client_name,''),'Vendég'),
    COALESCE(NEW.financial_closed_at::date,CURRENT_DATE),
    COALESCE(NEW.completed_at::date,NEW.financial_closed_at::date,CURRENT_DATE),
    COALESCE(NEW.financial_closed_at::date,CURRENT_DATE),
    'HUF',v_total,0,v_total,v_invoice_status,NEW.id::text,
    'Automatikusan létrehozva a lezárt munkalapból. Az ÁFA-bontás és a számlaadatok véglegesítése ellenőrzendő.',
    COALESCE(NEW.financial_closed_by,'system'),now(),now()
  )
  ON CONFLICT (work_order_id) WHERE direction='outgoing' AND work_order_id IS NOT NULL AND status <> 'cancelled'
  DO UPDATE SET
    location_id=EXCLUDED.location_id,
    partner_name=EXCLUDED.partner_name,
    performance_date=EXCLUDED.performance_date,
    gross_total=EXCLUDED.gross_total,
    net_total=CASE WHEN finance_invoices.vat_total=0 THEN EXCLUDED.gross_total ELSE finance_invoices.net_total END,
    status=CASE WHEN finance_invoices.status='draft' AND NEW.invoice_status='issued' THEN 'approved' ELSE finance_invoices.status END,
    invoice_no=COALESCE(finance_invoices.invoice_no,EXCLUDED.invoice_no),
    updated_at=now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vir_sync_outgoing_invoice_from_work_order ON work_orders;
CREATE TRIGGER trg_vir_sync_outgoing_invoice_from_work_order
AFTER INSERT OR UPDATE OF invoice_status,financial_closed_at,gross_total,discount_amount,tip_amount,amount_due
ON work_orders
FOR EACH ROW
EXECUTE FUNCTION vir_sync_outgoing_invoice_from_work_order();

CREATE OR REPLACE FUNCTION vir_sync_incoming_invoice_from_purchase_order()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_received_total numeric(14,2);
  v_expected_total numeric(14,2);
  v_total numeric(14,2);
BEGIN
  IF COALESCE(NEW.status,'draft') NOT IN ('partially_received','received') THEN
    RETURN NEW;
  END IF;

  SELECT
    COALESCE(SUM(received_quantity * COALESCE(actual_unit_cost,unit_cost)),0),
    COALESCE(SUM(ordered_quantity * unit_cost),0)
  INTO v_received_total,v_expected_total
  FROM purchase_order_items
  WHERE purchase_order_id=NEW.id;

  v_total := CASE WHEN v_received_total > 0 THEN v_received_total ELSE v_expected_total END;

  INSERT INTO finance_invoices(
    location_id,direction,partner_name,issue_date,performance_date,due_date,currency,
    net_total,vat_total,gross_total,status,purchase_order_id,note,created_by,created_at,updated_at
  ) VALUES (
    NEW.location_id,'incoming',COALESCE(NULLIF(NEW.supplier_name,''),'Beszállító'),
    CURRENT_DATE,COALESCE(NEW.received_at::date,CURRENT_DATE),CURRENT_DATE,'HUF',
    v_total,0,v_total,'draft',NEW.id::text,
    'Automatikusan létrehozva a beszerzési rendelés bevételezésekor. A beszállítói számlaszám, fizetési határidő és ÁFA-bontás kitöltése szükséges.',
    COALESCE(NEW.updated_by,NEW.created_by,'system'),now(),now()
  )
  ON CONFLICT (purchase_order_id) WHERE direction='incoming' AND purchase_order_id IS NOT NULL AND status <> 'cancelled'
  DO UPDATE SET
    location_id=EXCLUDED.location_id,
    partner_name=EXCLUDED.partner_name,
    performance_date=EXCLUDED.performance_date,
    gross_total=EXCLUDED.gross_total,
    net_total=CASE WHEN finance_invoices.vat_total=0 THEN EXCLUDED.gross_total ELSE finance_invoices.net_total END,
    updated_at=now();

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vir_sync_incoming_invoice_from_purchase_order ON purchase_orders;
CREATE TRIGGER trg_vir_sync_incoming_invoice_from_purchase_order
AFTER INSERT OR UPDATE OF status,received_at,updated_at
ON purchase_orders
FOR EACH ROW
EXECUTE FUNCTION vir_sync_incoming_invoice_from_purchase_order();

-- Korábbi, már lezárt munkalapok visszatöltése.
UPDATE work_orders
SET updated_at=now()
WHERE financial_closed_at IS NOT NULL
  AND COALESCE(invoice_status,'not_requested') IN ('requested','issued');

-- Korábbi bevételezett beszerzések visszatöltése.
UPDATE purchase_orders
SET updated_at=now()
WHERE status IN ('partially_received','received');

COMMIT;
