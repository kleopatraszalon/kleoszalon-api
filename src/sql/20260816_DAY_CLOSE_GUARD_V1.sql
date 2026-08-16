BEGIN;

CREATE OR REPLACE FUNCTION kleo_guard_day_close_open_workorders()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_blocking_id uuid;
  v_blocking_number text;
BEGIN
  SELECT wo.id, wo.work_order_number
    INTO v_blocking_id, v_blocking_number
  FROM work_orders wo
  LEFT JOIN appointments a ON a.id=wo.appointment_id
  WHERE wo.location_id::text=NEW.location_id::text
    AND COALESCE(a.start_time::date, wo.created_at::date)=NEW.business_date
    AND wo.financial_closed_at IS NULL
    AND COALESCE(lower(wo.status),'') NOT IN ('cancelled','canceled','archived')
  ORDER BY COALESCE(a.start_time,wo.created_at),wo.created_at,wo.id
  LIMIT 1;

  IF v_blocking_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE='P0001',
      MESSAGE='KLEO_DAY_CLOSE_BLOCKED',
      DETAIL=format('blocking_work_order_id=%s;work_order_number=%s',v_blocking_id,COALESCE(v_blocking_number,'')),
      HINT='Az üzleti nap csak minden vendég/munkalap pénzügyi lezárása után zárható.';
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_kleo_guard_day_close_open_workorders ON cash_register_closings;
CREATE TRIGGER trg_kleo_guard_day_close_open_workorders
BEFORE INSERT OR UPDATE OF business_date,location_id ON cash_register_closings
FOR EACH ROW EXECUTE FUNCTION kleo_guard_day_close_open_workorders();

COMMIT;
