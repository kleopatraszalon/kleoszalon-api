BEGIN;
SET LOCAL statement_timeout = 0;

-- V8: runtime-safe work-order reversal registration.
-- Reusing an idempotency key for another work order is a conflict, never an alias.
CREATE OR REPLACE FUNCTION kleo_register_work_order_reversal(
  p_work_order_id uuid,
  p_reason text,
  p_requested_by text,
  p_idempotency_key text
) RETURNS work_order_reversals
LANGUAGE plpgsql AS $$
DECLARE
  w record;
  r work_order_reversals;
  key_row work_order_reversals;
BEGIN
  IF length(btrim(COALESCE(p_reason,'')))<5 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='REVERSAL_REASON_REQUIRED';
  END IF;
  IF length(btrim(COALESCE(p_idempotency_key,'')))<8 THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='REVERSAL_IDEMPOTENCY_KEY_REQUIRED';
  END IF;

  -- Serialize retries and conflicting requests on the business key.
  PERFORM pg_advisory_xact_lock(hashtext('work-order-reversal|'||btrim(p_idempotency_key)));

  SELECT * INTO key_row FROM work_order_reversals
   WHERE idempotency_key=btrim(p_idempotency_key)
   LIMIT 1 FOR UPDATE;
  IF FOUND AND key_row.work_order_id IS DISTINCT FROM p_work_order_id THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='REVERSAL_IDEMPOTENCY_KEY_CONFLICT';
  END IF;

  SELECT id,tenant_id,location_id,status,locked_at,archived_at,archive_hash
    INTO w FROM work_orders WHERE id=p_work_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE='P0002',MESSAGE='WORK_ORDER_NOT_FOUND';
  END IF;
  IF w.locked_at IS NULL AND w.archived_at IS NULL AND COALESCE(w.status,'')<>'completed' THEN
    RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='WORK_ORDER_NOT_FINALIZED';
  END IF;

  SELECT * INTO r FROM work_order_reversals
   WHERE work_order_id=p_work_order_id
   ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN RETURN r; END IF;

  INSERT INTO work_order_reversals(
    work_order_id,tenant_id,location_id,reason,requested_by,idempotency_key,
    original_archive_hash,reversal_payload
  ) VALUES(
    p_work_order_id,w.tenant_id,w.location_id,btrim(p_reason),p_requested_by,btrim(p_idempotency_key),
    w.archive_hash,jsonb_build_object(
      'source_status',w.status,
      'source_locked_at',w.locked_at,
      'source_archived_at',w.archived_at
    )
  ) RETURNING * INTO r;
  RETURN r;
END $$;

COMMIT;
