BEGIN;

ALTER TABLE booking_communication_queue
  DROP CONSTRAINT IF EXISTS booking_communication_queue_status_ck;

ALTER TABLE booking_communication_queue
  ADD CONSTRAINT booking_communication_queue_status_ck
  CHECK(status IN ('pending','processing','sent','failed','cancelled','suppressed'));

CREATE INDEX IF NOT EXISTS booking_communication_queue_retry_idx
  ON booking_communication_queue(status,scheduled_at,attempt_count)
  WHERE status='pending';

COMMIT;
