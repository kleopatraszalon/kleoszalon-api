\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE tenants(id bigint PRIMARY KEY,slug text UNIQUE NOT NULL);
INSERT INTO tenants VALUES(1,'kleopatra'),(2,'franchise-b');
CREATE TABLE locations(id uuid PRIMARY KEY,tenant_id bigint NOT NULL REFERENCES tenants(id),name text);
INSERT INTO locations VALUES
 ('00000000-0000-0000-0000-000000000101',1,'Kleo A'),
 ('00000000-0000-0000-0000-000000000202',2,'Franchise B');

CREATE TABLE work_orders(
 id uuid PRIMARY KEY,tenant_id bigint,location_id uuid,status text,locked_at timestamptz,archived_at timestamptz,archive_hash text
);
CREATE TABLE finance_invoices(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid,direction text NOT NULL,invoice_no text,partner_name text,
 net_total numeric(14,2) DEFAULT 0,vat_total numeric(14,2) DEFAULT 0,gross_total numeric(14,2) DEFAULT 0,status text DEFAULT 'draft'
);
CREATE TABLE financial_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),location_id uuid);
CREATE TABLE loyalty_accounts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),customer_id text);
CREATE TABLE loyalty_transactions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL,transaction_type text,reference_type text,reference_id text
);
CREATE TABLE daily_action_campaigns(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),status text DEFAULT 'draft',valid_from timestamptz DEFAULT now(),valid_until timestamptz DEFAULT now()+interval '1 day'
);

-- Historic bad/duplicate-shaped data must not make the migration undeployable.
INSERT INTO finance_invoices(location_id,direction,invoice_no,net_total,vat_total,gross_total,status) VALUES
 ('00000000-0000-0000-0000-000000000101','incoming','LEGACY-1',100,27,999,'draft'),
 ('00000000-0000-0000-0000-000000000101','incoming','LEGACY-1',100,27,999,'draft');

\i src/sql/20260816_ENTERPRISE_INTEGRITY_V7.sql

DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    INSERT INTO financial_movements(location_id,tenant_id) VALUES('00000000-0000-0000-0000-000000000202',1);
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'cross-tenant financial write was not blocked'; END IF;
END $$;

DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    INSERT INTO finance_invoices(location_id,tenant_id,direction,invoice_no,supplier_invoice_number,net_total,vat_total,gross_total,status)
    VALUES('00000000-0000-0000-0000-000000000101',1,'incoming','BAD-MATH','BAD-MATH',100,27,128,'draft');
  EXCEPTION WHEN check_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'invoice arithmetic mismatch was not blocked'; END IF;
END $$;

INSERT INTO finance_invoices(location_id,tenant_id,direction,invoice_no,supplier_invoice_number,net_total,vat_total,gross_total,status)
VALUES('00000000-0000-0000-0000-000000000101',1,'incoming','NEW-42','NEW-42',100,27,127,'draft');
DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    INSERT INTO finance_invoices(location_id,tenant_id,direction,invoice_no,supplier_invoice_number,net_total,vat_total,gross_total,status)
    VALUES('00000000-0000-0000-0000-000000000101',1,'incoming','NEW-42','NEW-42',100,27,127,'draft');
  EXCEPTION WHEN unique_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'supplier invoice duplicate was not blocked'; END IF;
END $$;

INSERT INTO finance_invoices(location_id,tenant_id,direction,invoice_no,supplier_invoice_number,source_receipt_id,net_total,vat_total,gross_total,status)
VALUES('00000000-0000-0000-0000-000000000101',1,'incoming','REC-1','REC-1','receipt-abc',10,2.7,12.7,'draft');
DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    INSERT INTO finance_invoices(location_id,tenant_id,direction,invoice_no,supplier_invoice_number,source_receipt_id,net_total,vat_total,gross_total,status)
    VALUES('00000000-0000-0000-0000-000000000101',1,'incoming','REC-2','REC-2','receipt-abc',10,2.7,12.7,'draft');
  EXCEPTION WHEN unique_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'receipt source duplicate was not blocked'; END IF;
END $$;

INSERT INTO loyalty_accounts(id,customer_id) VALUES('00000000-0000-0000-0000-000000000301','c1');
INSERT INTO loyalty_transactions(account_id,transaction_type,reference_type,reference_id)
VALUES('00000000-0000-0000-0000-000000000301','balance_topup','topup','idem-001');
DO $$
DECLARE blocked boolean:=false;
BEGIN
  BEGIN
    INSERT INTO loyalty_transactions(account_id,transaction_type,reference_type,reference_id)
    VALUES('00000000-0000-0000-0000-000000000301','balance_topup','topup','idem-001');
  EXCEPTION WHEN unique_violation THEN blocked:=true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'loyalty duplicate top-up was not blocked'; END IF;
END $$;

INSERT INTO work_orders(id,tenant_id,location_id,status,locked_at,archived_at,archive_hash)
VALUES('00000000-0000-0000-0000-000000000401',1,'00000000-0000-0000-0000-000000000101','completed',now(),now(),'hash-a');
DO $$
DECLARE a uuid;b uuid;
BEGIN
 SELECT id INTO a FROM kleo_register_work_order_reversal('00000000-0000-0000-0000-000000000401','hibás elszámolás','ci','reversal-0001');
 SELECT id INTO b FROM kleo_register_work_order_reversal('00000000-0000-0000-0000-000000000401','hibás elszámolás','ci','reversal-0001');
 IF a IS DISTINCT FROM b THEN RAISE EXCEPTION 'reversal retry was not idempotent'; END IF;
 IF (SELECT count(*) FROM work_order_reversals WHERE work_order_id='00000000-0000-0000-0000-000000000401')<>1 THEN RAISE EXCEPTION 'reversal duplicated'; END IF;
END $$;

INSERT INTO work_orders(id,tenant_id,location_id,status)
VALUES('00000000-0000-0000-0000-000000000402',1,'00000000-0000-0000-0000-000000000101','in_progress');
DO $$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  PERFORM kleo_register_work_order_reversal('00000000-0000-0000-0000-000000000402','nem lezárt','ci','reversal-0002');
 EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'unfinalized work order reversal was not blocked'; END IF;
END $$;

INSERT INTO daily_action_campaigns(id,status) VALUES('00000000-0000-0000-0000-000000000501','published');
DO $$
DECLARE blocked boolean:=false;
BEGIN
 BEGIN
  INSERT INTO daily_action_campaign_locations(campaign_id,location_id,tenant_id)
  VALUES('00000000-0000-0000-0000-000000000501','00000000-0000-0000-0000-000000000202',1);
 EXCEPTION WHEN check_violation THEN blocked:=true; END;
 IF NOT blocked THEN RAISE EXCEPTION 'cross-tenant daily-action target was not blocked'; END IF;
END $$;

SELECT 'PASS enterprise_integrity_v16' AS result;
