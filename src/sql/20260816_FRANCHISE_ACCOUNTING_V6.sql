BEGIN;

ALTER TABLE franchise_members ADD COLUMN IF NOT EXISTS billing_legal_name text;
ALTER TABLE franchise_members ADD COLUMN IF NOT EXISTS billing_tax_number text;
ALTER TABLE franchise_members ADD COLUMN IF NOT EXISTS billing_email text;
ALTER TABLE franchise_members ADD COLUMN IF NOT EXISTS billing_country_code text;
ALTER TABLE franchise_members ADD COLUMN IF NOT EXISTS billing_postal_code text;
ALTER TABLE franchise_members ADD COLUMN IF NOT EXISTS billing_city text;
ALTER TABLE franchise_members ADD COLUMN IF NOT EXISTS billing_address text;
ALTER TABLE franchise_members ADD COLUMN IF NOT EXISTS billing_vat_rate numeric(8,6);

CREATE TABLE IF NOT EXISTS franchise_receivables(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  settlement_id bigint NOT NULL REFERENCES franchise_settlements(id) ON DELETE CASCADE,
  franchise_member_id bigint NOT NULL REFERENCES franchise_members(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  currency text NOT NULL,
  royalty_amount numeric(16,2) NOT NULL,
  marketing_fee_amount numeric(16,2) NOT NULL,
  net_amount numeric(16,2) NOT NULL,
  vat_rate numeric(8,6),
  vat_amount numeric(16,2),
  gross_amount numeric(16,2),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'posted' CHECK(status IN('posted','invoice_draft','invoiced','paid','void')),
  billing_legal_name text,
  billing_tax_number text,
  billing_email text,
  billing_country_code text,
  billing_postal_code text,
  billing_city text,
  billing_address text,
  finance_invoice_id uuid,
  posted_by text,
  posted_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tenant_id,settlement_id)
);
CREATE INDEX IF NOT EXISTS franchise_receivables_period_idx ON franchise_receivables(tenant_id,period_start,status);

CREATE TABLE IF NOT EXISTS franchise_receivable_events(
  id bigserial PRIMARY KEY,
  tenant_id bigint NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  receivable_id bigint NOT NULL REFERENCES franchise_receivables(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  actor_user_id text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF to_regclass('public.finance_invoices') IS NOT NULL THEN
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS franchise_settlement_id bigint;
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS franchise_receivable_id bigint;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION franchise_capture_issued_workorder_invoice()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m record;
BEGIN
  IF NEW.direction <> 'outgoing'
     OR COALESCE(NEW.document_kind,'') <> 'tax_invoice'
     OR NEW.issued_at IS NULL
     OR NEW.work_order_id IS NULL
     OR COALESCE(NEW.net_total,0) <= 0
     OR NEW.franchise_settlement_id IS NOT NULL
  THEN RETURN NEW; END IF;

  SELECT fm.id, fm.tenant_id, fm.franchise_network_id
    INTO m
    FROM franchise_members fm
   WHERE fm.location_id=NEW.location_id::text
     AND fm.member_type='franchise'
     AND fm.active=true
   ORDER BY fm.id
   LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  INSERT INTO franchise_revenue_entries(
    tenant_id,franchise_network_id,franchise_member_id,location_id,occurred_at,currency,net_revenue,source_type,source_id,source_payload
  ) VALUES(
    m.tenant_id,m.franchise_network_id,m.id,NEW.location_id::text,NEW.issued_at,COALESCE(NEW.currency,'HUF'),ROUND(NEW.net_total::numeric,2),
    'workorder_invoice',NEW.id::text,
    jsonb_build_object('invoice_no',NEW.invoice_no,'work_order_id',NEW.work_order_id,'gross_total',NEW.gross_total,'vat_total',NEW.vat_total,'document_kind',NEW.document_kind)
  ) ON CONFLICT(tenant_id,source_type,source_id) DO NOTHING;
  RETURN NEW;
END $$;

DO $$
BEGIN
  IF to_regclass('public.finance_invoices') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_franchise_capture_workorder_invoice ON finance_invoices;
    CREATE TRIGGER trg_franchise_capture_workorder_invoice
      AFTER INSERT OR UPDATE OF document_kind,issued_at,net_total,status ON finance_invoices
      FOR EACH ROW EXECUTE FUNCTION franchise_capture_issued_workorder_invoice();
  END IF;
END $$;

CREATE OR REPLACE FUNCTION franchise_sync_receivable_paid()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status='paid' AND OLD.status IS DISTINCT FROM NEW.status THEN
    UPDATE franchise_receivables SET status='paid',updated_at=now() WHERE settlement_id=NEW.id AND tenant_id=NEW.tenant_id AND status<>'void';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_franchise_sync_receivable_paid ON franchise_settlements;
CREATE TRIGGER trg_franchise_sync_receivable_paid AFTER UPDATE OF status ON franchise_settlements FOR EACH ROW EXECUTE FUNCTION franchise_sync_receivable_paid();

COMMIT;
