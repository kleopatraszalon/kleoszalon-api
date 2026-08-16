BEGIN;
SET LOCAL statement_timeout = 0;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- V9: testable CRM complaint lifecycle and idempotent loyalty wallet top-up.
-- These functions centralize the business invariants so retries and direct service calls
-- cannot bypass closing-evidence or duplicate-payment protections.

CREATE OR REPLACE FUNCTION kleo_create_complaint(
  p_title text,
  p_description text,
  p_assignee text,
  p_location_name text,
  p_sla_days integer,
  p_actor text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r record; sla integer:=GREATEST(1,COALESCE(p_sla_days,5));
BEGIN
  IF length(btrim(COALESCE(p_title,'')))<3 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMPLAINT_TITLE_REQUIRED';
  END IF;
  IF length(btrim(COALESCE(p_assignee,'')))<2 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMPLAINT_OWNER_REQUIRED';
  END IF;
  INSERT INTO operations_quality_records(
    module_key,title,description,location_name,assignee,priority,status,due_at,requires_approval,metadata
  ) VALUES(
    'complaints',btrim(p_title),NULLIF(btrim(COALESCE(p_description,'')),''),NULLIF(btrim(COALESCE(p_location_name,'')),''),
    btrim(p_assignee),'high','open',now()+make_interval(days=>sla),true,
    jsonb_build_object('sla_days',sla,'created_by',COALESCE(NULLIF(btrim(p_actor),''),'system'),'closing_evidence',NULL)
  ) RETURNING id,status,assignee,due_at,created_at,metadata INTO r;
  RETURN jsonb_build_object('id',r.id,'status',r.status,'owner',r.assignee,'due_at',r.due_at,'created_at',r.created_at,'metadata',r.metadata);
END $$;

CREATE OR REPLACE FUNCTION kleo_close_complaint(
  p_complaint_id uuid,
  p_closing_evidence text,
  p_actor text
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE r record; evidence text:=btrim(COALESCE(p_closing_evidence,''));
BEGIN
  SELECT id,module_key,status,metadata INTO r FROM operations_quality_records WHERE id=p_complaint_id FOR UPDATE;
  IF NOT FOUND OR r.module_key IS DISTINCT FROM 'complaints' THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='COMPLAINT_NOT_FOUND';
  END IF;
  IF r.status IN('resolved','closed','archived') THEN
    RETURN jsonb_build_object('id',r.id,'status',r.status,'idempotent',true,'metadata',r.metadata);
  END IF;
  IF length(evidence)<3 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='COMPLAINT_CLOSING_EVIDENCE_REQUIRED';
  END IF;
  UPDATE operations_quality_records
     SET status='resolved',completed_at=now(),updated_at=now(),
         metadata=COALESCE(metadata,'{}'::jsonb)||jsonb_build_object(
           'closing_evidence',evidence,'closed_by',COALESCE(NULLIF(btrim(p_actor),''),'system'),'closed_at',now()
         )
   WHERE id=p_complaint_id
   RETURNING id,status,completed_at,metadata INTO r;
  RETURN jsonb_build_object('id',r.id,'status',r.status,'completed_at',r.completed_at,'idempotent',false,'metadata',r.metadata);
END $$;

CREATE OR REPLACE FUNCTION kleo_loyalty_wallet_topup(
  p_account_id uuid,
  p_amount numeric,
  p_reference_id text,
  p_actor text,
  p_work_order_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE a record; existing record; tx_id uuid; ref text:=btrim(COALESCE(p_reference_id,''));
BEGIN
  IF COALESCE(p_amount,0)<=0 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='LOYALTY_TOPUP_POSITIVE_AMOUNT_REQUIRED';
  END IF;
  IF length(ref)<3 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='LOYALTY_TOPUP_REFERENCE_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('loyalty-wallet-topup|'||p_account_id::text||'|'||ref));
  SELECT id,amount INTO existing FROM loyalty_transactions
   WHERE account_id=p_account_id AND transaction_type='balance_topup' AND reference_type='topup' AND reference_id=ref
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    SELECT id,balance,customer_id INTO a FROM loyalty_accounts WHERE id=p_account_id;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='LOYALTY_ACCOUNT_NOT_FOUND'; END IF;
    RETURN jsonb_build_object('account_id',a.id,'balance',a.balance,'transaction_id',existing.id,'reference_id',ref,'idempotent',true);
  END IF;
  UPDATE loyalty_accounts SET balance=balance+p_amount,updated_at=now() WHERE id=p_account_id
   RETURNING id,balance,customer_id INTO a;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='LOYALTY_ACCOUNT_NOT_FOUND'; END IF;
  INSERT INTO loyalty_transactions(account_id,transaction_type,amount,work_order_id,reference_type,reference_id,note,created_by)
   VALUES(p_account_id,'balance_topup',p_amount,p_work_order_id,'topup',ref,'Vendégegyenleg feltöltés',COALESCE(NULLIF(btrim(p_actor),''),'system'))
   RETURNING id INTO tx_id;
  IF to_regclass('public.loyalty_sales') IS NOT NULL THEN
    INSERT INTO loyalty_sales(sale_type,reference_id,account_id,customer_id,work_order_id,gross_amount,commission_base,revenue_recognized,note,created_by)
    VALUES('wallet_topup',tx_id::text,p_account_id,a.customer_id,p_work_order_id,p_amount,p_amount,true,'Vendégegyenleg feltöltés',COALESCE(NULLIF(btrim(p_actor),''),'system'));
  END IF;
  RETURN jsonb_build_object('account_id',a.id,'balance',a.balance,'transaction_id',tx_id,'reference_id',ref,'idempotent',false);
END $$;

COMMIT;
