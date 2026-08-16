\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE operations_quality_records(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),module_key text NOT NULL,title text NOT NULL,description text,
 location_name text,assignee text,priority text,status text NOT NULL,due_at timestamptz,requires_approval boolean DEFAULT false,
 completed_at timestamptz,metadata jsonb DEFAULT '{}'::jsonb,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now()
);
CREATE TABLE loyalty_accounts(
 id uuid PRIMARY KEY,customer_id text,balance numeric(14,2) NOT NULL DEFAULT 0,updated_at timestamptz DEFAULT now()
);
CREATE TABLE loyalty_transactions(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid NOT NULL,transaction_type text NOT NULL,amount numeric(14,2),
 work_order_id uuid,reference_type text,reference_id text,note text,created_by text,created_at timestamptz DEFAULT now()
);
CREATE TABLE loyalty_sales(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),sale_type text,reference_id text,account_id uuid,customer_id text,work_order_id uuid,
 gross_amount numeric(14,2),commission_base numeric(14,2),revenue_recognized boolean,note text,created_by text,created_at timestamptz DEFAULT now()
);

\i src/sql/20260816_CRM_LOYALTY_INTEGRITY_V9.sql

-- KLEO-FUN-CRM-001 / KLEO-FUN-CRM-001-AC-01
DO $$
DECLARE c jsonb;
BEGIN
 c:=kleo_create_complaint('Próba panasz','Részletes leírás','Üzletvezető','Teszt szalon',5,'ci');
 IF c->>'status'<>'open' OR NULLIF(c->>'id','') IS NULL OR NULLIF(c->>'owner','') IS NULL OR NULLIF(c->>'due_at','') IS NULL THEN
   RAISE EXCEPTION 'complaint creation invariant failed: %',c;
 END IF;
END $$;

-- KLEO-FUN-CRM-001 / KLEO-FUN-CRM-001-AC-02
DO $$
DECLARE cid uuid;blocked boolean:=false;closed jsonb;
BEGIN
 SELECT id INTO cid FROM operations_quality_records WHERE module_key='complaints' ORDER BY created_at LIMIT 1;
 BEGIN
   PERFORM kleo_close_complaint(cid,'','ci');
 EXCEPTION WHEN invalid_parameter_value THEN
   IF SQLERRM LIKE '%COMPLAINT_CLOSING_EVIDENCE_REQUIRED%' THEN blocked:=true; ELSE RAISE; END IF;
 END;
 IF NOT blocked THEN RAISE EXCEPTION 'complaint closed without evidence'; END IF;
 IF (SELECT status FROM operations_quality_records WHERE id=cid)<>'open' THEN RAISE EXCEPTION 'blocked complaint changed state'; END IF;
 closed:=kleo_close_complaint(cid,'Vendég visszaigazolta a megoldást.','ci');
 IF closed->>'status'<>'resolved' OR NULLIF(closed#>>'{metadata,closing_evidence}','') IS NULL OR NULLIF(closed->>'completed_at','') IS NULL THEN
   RAISE EXCEPTION 'complaint evidence close failed: %',closed;
 END IF;
END $$;

INSERT INTO loyalty_accounts(id,customer_id,balance) VALUES('00000000-0000-0000-0000-000000000901','customer-v19',1000);

-- KLEO-FUN-LOY-001 / KLEO-FUN-LOY-001-AC-01
DO $$
DECLARE r jsonb;cnt integer;
BEGIN
 r:=kleo_loyalty_wallet_topup('00000000-0000-0000-0000-000000000901',5000,'payment-v19-001','ci',NULL);
 SELECT count(*) INTO cnt FROM loyalty_transactions WHERE account_id='00000000-0000-0000-0000-000000000901' AND transaction_type='balance_topup';
 IF (r->>'balance')::numeric<>6000 OR cnt<>1 OR (r->>'idempotent')::boolean THEN RAISE EXCEPTION 'wallet topup invariant failed: % / %',r,cnt; END IF;
END $$;

-- KLEO-FUN-LOY-001 / KLEO-FUN-LOY-001-AC-02
DO $$
DECLARE r jsonb;cnt integer;bal numeric;
BEGIN
 r:=kleo_loyalty_wallet_topup('00000000-0000-0000-0000-000000000901',5000,'payment-v19-001','ci',NULL);
 SELECT count(*),max(a.balance) INTO cnt,bal FROM loyalty_transactions t JOIN loyalty_accounts a ON a.id=t.account_id
  WHERE t.account_id='00000000-0000-0000-0000-000000000901' AND t.transaction_type='balance_topup';
 IF NOT (r->>'idempotent')::boolean OR cnt<>1 OR bal<>6000 THEN RAISE EXCEPTION 'wallet topup retry duplicated effect: % / % / %',r,cnt,bal; END IF;
END $$;

SELECT 'PASS crm_loyalty_v19' AS result;
