BEGIN;
SET LOCAL statement_timeout = 0;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- KLEO Enterprise Integrity V7
-- Cross-module DB boundary for SaaS/franchise, finance, loyalty, reversal and marketing ownership.

DO $$
DECLARE default_tenant bigint;
BEGIN
  IF to_regclass('public.tenants') IS NULL THEN RAISE EXCEPTION 'tenants table missing: SaaS Core V1 must run first'; END IF;
  SELECT id INTO default_tenant FROM tenants WHERE slug='kleopatra' LIMIT 1;
  IF default_tenant IS NULL THEN RAISE EXCEPTION 'kleopatra tenant missing'; END IF;

  IF to_regclass('public.finance_invoices') IS NOT NULL THEN
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS tenant_id bigint;
    UPDATE finance_invoices f SET tenant_id=l.tenant_id FROM locations l
     WHERE f.tenant_id IS NULL AND f.location_id IS NOT NULL AND f.location_id::text=l.id::text;
    UPDATE finance_invoices SET tenant_id=default_tenant WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS finance_invoices_tenant_idx ON finance_invoices(tenant_id);
  END IF;

  IF to_regclass('public.financial_movements') IS NOT NULL THEN
    ALTER TABLE financial_movements ADD COLUMN IF NOT EXISTS tenant_id bigint;
    UPDATE financial_movements f SET tenant_id=l.tenant_id FROM locations l
     WHERE f.tenant_id IS NULL AND f.location_id IS NOT NULL AND f.location_id::text=l.id::text;
    UPDATE financial_movements SET tenant_id=default_tenant WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS financial_movements_tenant_idx ON financial_movements(tenant_id);
  END IF;

  IF to_regclass('public.daily_action_campaigns') IS NOT NULL THEN
    ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS tenant_id bigint;
    ALTER TABLE daily_action_campaigns ADD COLUMN IF NOT EXISTS location_id uuid;
    UPDATE daily_action_campaigns d SET tenant_id=l.tenant_id FROM locations l
     WHERE d.tenant_id IS NULL AND d.location_id IS NOT NULL AND d.location_id::text=l.id::text;
    UPDATE daily_action_campaigns SET tenant_id=default_tenant WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS daily_action_campaigns_tenant_location_idx ON daily_action_campaigns(tenant_id,location_id,status,valid_from,valid_until);
  END IF;

  IF to_regclass('public.loyalty_accounts') IS NOT NULL THEN
    ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS tenant_id bigint;
    UPDATE loyalty_accounts SET tenant_id=default_tenant WHERE tenant_id IS NULL;
    CREATE INDEX IF NOT EXISTS loyalty_accounts_tenant_idx ON loyalty_accounts(tenant_id);
  END IF;
END $$;

-- Any location-bound write must belong to the location's tenant.
CREATE OR REPLACE FUNCTION kleo_guard_tenant_location_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_tenant bigint;
BEGIN
  IF NEW.location_id IS NULL OR NEW.tenant_id IS NULL THEN RETURN NEW; END IF;
  SELECT tenant_id INTO expected_tenant FROM locations WHERE id::text=NEW.location_id::text LIMIT 1;
  IF expected_tenant IS NULL THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='KLEO_TENANT_LOCATION_UNKNOWN'; END IF;
  IF NEW.tenant_id IS DISTINCT FROM expected_tenant THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='KLEO_CROSS_TENANT_WRITE_BLOCKED'; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_invoices','financial_movements','daily_action_campaigns','purchase_orders','work_orders','appointments'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL
       AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='tenant_id')
       AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='location_id') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_tenant_location_guard ON %I',t,t);
      EXECUTE format('CREATE TRIGGER trg_%I_tenant_location_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id ON %I FOR EACH ROW EXECUTE FUNCTION kleo_guard_tenant_location_consistency()',t,t);
    END IF;
  END LOOP;
END $$;

-- Incoming invoice identity and arithmetic integrity.
DO $$
BEGIN
  IF to_regclass('public.finance_invoices') IS NOT NULL THEN
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS supplier_invoice_number text;
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS supplier_id uuid;
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS source_receipt_id text;
    ALTER TABLE finance_invoices ADD COLUMN IF NOT EXISTS source_purchase_order_id text;
    UPDATE finance_invoices SET supplier_invoice_number=NULLIF(btrim(invoice_no),'')
     WHERE direction='incoming' AND supplier_invoice_number IS NULL AND NULLIF(btrim(invoice_no),'') IS NOT NULL;
    IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='chk_finance_invoices_totals_v7') THEN
      ALTER TABLE finance_invoices ADD CONSTRAINT chk_finance_invoices_totals_v7
       CHECK(abs(round((COALESCE(net_total,0)+COALESCE(vat_total,0)-COALESCE(gross_total,0))::numeric,2))<=0.01) NOT VALID;
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION kleo_guard_incoming_invoice_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE duplicate_id uuid; business_key text;
BEGIN
  IF NEW.direction IS DISTINCT FROM 'incoming' OR NEW.status IN('void','cancelled','storno') THEN RETURN NEW; END IF;
  IF NULLIF(btrim(NEW.supplier_invoice_number),'') IS NOT NULL THEN
    business_key:=concat_ws('|','invoice',NEW.tenant_id,COALESCE(NEW.supplier_id::text,'-'),lower(btrim(NEW.supplier_invoice_number)));
    PERFORM pg_advisory_xact_lock(hashtext(business_key));
    SELECT id INTO duplicate_id FROM finance_invoices
     WHERE id IS DISTINCT FROM NEW.id AND direction='incoming' AND status NOT IN('void','cancelled','storno')
       AND tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND supplier_id IS NOT DISTINCT FROM NEW.supplier_id
       AND lower(btrim(supplier_invoice_number))=lower(btrim(NEW.supplier_invoice_number)) LIMIT 1;
    IF duplicate_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='DUPLICATE_SUPPLIER_INVOICE'; END IF;
  END IF;
  IF NULLIF(btrim(NEW.source_receipt_id),'') IS NOT NULL THEN
    business_key:=concat_ws('|','receipt',NEW.tenant_id,btrim(NEW.source_receipt_id));
    PERFORM pg_advisory_xact_lock(hashtext(business_key));
    SELECT id INTO duplicate_id FROM finance_invoices
     WHERE id IS DISTINCT FROM NEW.id AND direction='incoming' AND status NOT IN('void','cancelled','storno')
       AND tenant_id IS NOT DISTINCT FROM NEW.tenant_id AND source_receipt_id=NEW.source_receipt_id LIMIT 1;
    IF duplicate_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='DUPLICATE_RECEIPT_INVOICE'; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF to_regclass('public.finance_invoices') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_finance_invoices_identity_v7 ON finance_invoices;
    CREATE TRIGGER trg_finance_invoices_identity_v7 BEFORE INSERT OR UPDATE OF tenant_id,supplier_id,supplier_invoice_number,source_receipt_id,status
      ON finance_invoices FOR EACH ROW EXECUTE FUNCTION kleo_guard_incoming_invoice_identity();
  END IF;
END $$;

-- Loyalty top-up deduplication. Advisory lock closes the parallel-request race without
-- requiring historic rows to satisfy a new UNIQUE index.
CREATE OR REPLACE FUNCTION kleo_guard_loyalty_topup_reference()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE duplicate_id text; business_key text;
BEGIN
  IF NEW.transaction_type='balance_topup' AND NEW.reference_type='topup' AND NULLIF(btrim(NEW.reference_id),'') IS NOT NULL THEN
    business_key:=concat_ws('|','loyalty-topup',NEW.account_id::text,btrim(NEW.reference_id));
    PERFORM pg_advisory_xact_lock(hashtext(business_key));
    SELECT id::text INTO duplicate_id FROM loyalty_transactions
     WHERE id IS DISTINCT FROM NEW.id AND account_id=NEW.account_id AND transaction_type='balance_topup'
       AND reference_type='topup' AND reference_id=NEW.reference_id LIMIT 1;
    IF duplicate_id IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='DUPLICATE_LOYALTY_TOPUP'; END IF;
  END IF;
  RETURN NEW;
END $$;
DO $$ BEGIN
  IF to_regclass('public.loyalty_transactions') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS trg_loyalty_topup_reference_v7 ON loyalty_transactions;
    CREATE TRIGGER trg_loyalty_topup_reference_v7 BEFORE INSERT OR UPDATE OF account_id,transaction_type,reference_type,reference_id
      ON loyalty_transactions FOR EACH ROW EXECUTE FUNCTION kleo_guard_loyalty_topup_reference();
  END IF;
END $$;

-- Work-order reversal audit core: immutable source + compensating event registration.
CREATE TABLE IF NOT EXISTS work_order_reversals(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE RESTRICT,
  tenant_id bigint,location_id uuid,reason text NOT NULL CHECK(length(btrim(reason))>=5),requested_by text NOT NULL,
  idempotency_key text NOT NULL,status text NOT NULL DEFAULT 'requested' CHECK(status IN('requested','processing','completed','failed')),
  reversal_payload jsonb NOT NULL DEFAULT '{}'::jsonb,original_archive_hash text,created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,failure_code text,failure_detail text,UNIQUE(work_order_id),UNIQUE(idempotency_key));
CREATE INDEX IF NOT EXISTS work_order_reversals_tenant_location_idx ON work_order_reversals(tenant_id,location_id,created_at DESC);

CREATE OR REPLACE FUNCTION kleo_register_work_order_reversal(p_work_order_id uuid,p_reason text,p_requested_by text,p_idempotency_key text)
RETURNS work_order_reversals LANGUAGE plpgsql AS $$
DECLARE w record; r work_order_reversals;
BEGIN
  IF length(btrim(COALESCE(p_reason,'')))<5 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='REVERSAL_REASON_REQUIRED'; END IF;
  IF length(btrim(COALESCE(p_idempotency_key,'')))<8 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='REVERSAL_IDEMPOTENCY_KEY_REQUIRED'; END IF;
  SELECT id,tenant_id,location_id,status,locked_at,archived_at,archive_hash INTO w FROM work_orders WHERE id=p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='WORK_ORDER_NOT_FOUND'; END IF;
  IF w.locked_at IS NULL AND w.archived_at IS NULL AND COALESCE(w.status,'')<>'completed' THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WORK_ORDER_NOT_FINALIZED'; END IF;
  SELECT * INTO r FROM work_order_reversals WHERE work_order_id=p_work_order_id OR idempotency_key=p_idempotency_key ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN RETURN r; END IF;
  INSERT INTO work_order_reversals(work_order_id,tenant_id,location_id,reason,requested_by,idempotency_key,original_archive_hash,reversal_payload)
   VALUES(p_work_order_id,w.tenant_id,w.location_id,btrim(p_reason),p_requested_by,p_idempotency_key,w.archive_hash,
    jsonb_build_object('source_status',w.status,'source_locked_at',w.locked_at,'source_archived_at',w.archived_at)) RETURNING * INTO r;
  RETURN r;
END $$;

-- Explicit daily-action location ownership, created only after the marketing schema exists.
DO $$ BEGIN
  IF to_regclass('public.daily_action_campaigns') IS NOT NULL THEN
    CREATE TABLE IF NOT EXISTS daily_action_campaign_locations(
      campaign_id uuid NOT NULL REFERENCES daily_action_campaigns(id) ON DELETE CASCADE,
      location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,tenant_id bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(campaign_id,location_id));
    CREATE INDEX IF NOT EXISTS daily_action_campaign_locations_tenant_idx ON daily_action_campaign_locations(tenant_id,location_id);
    DROP TRIGGER IF EXISTS trg_daily_action_campaign_locations_tenant_location_guard ON daily_action_campaign_locations;
    CREATE TRIGGER trg_daily_action_campaign_locations_tenant_location_guard BEFORE INSERT OR UPDATE OF tenant_id,location_id
      ON daily_action_campaign_locations FOR EACH ROW EXECUTE FUNCTION kleo_guard_tenant_location_consistency();
  END IF;
END $$;

-- Deployment assertion: no tenant/location mismatch may survive the migration.
DO $$
DECLARE t text; mismatch_count bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_invoices','financial_movements','daily_action_campaigns','purchase_orders','work_orders','appointments'] LOOP
    IF to_regclass('public.'||t) IS NOT NULL
       AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='tenant_id')
       AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=t AND column_name='location_id') THEN
      EXECUTE format('SELECT count(*) FROM %I x JOIN locations l ON l.id::text=x.location_id::text WHERE x.location_id IS NOT NULL AND x.tenant_id IS DISTINCT FROM l.tenant_id',t) INTO mismatch_count;
      IF mismatch_count>0 THEN RAISE EXCEPTION 'Tenant/location mismatch in %: % rows',t,mismatch_count; END IF;
    END IF;
  END LOOP;
END $$;

COMMIT;
