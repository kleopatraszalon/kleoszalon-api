-- NAV Online Számla queue worker hardening
-- Biztonságos automatikus beküldési/polling sor, idempotens migráció.

ALTER TABLE nav_invoice_queue
  ADD COLUMN IF NOT EXISTS submission_id uuid,
  ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS last_result jsonb;

DO $$
BEGIN
  IF to_regclass('public.nav_invoice_submissions') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conname='nav_invoice_queue_submission_fk'
         AND conrelid='public.nav_invoice_queue'::regclass
     ) THEN
    ALTER TABLE nav_invoice_queue
      ADD CONSTRAINT nav_invoice_queue_submission_fk
      FOREIGN KEY(submission_id) REFERENCES nav_invoice_submissions(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS nav_invoice_queue_submission_idx
  ON nav_invoice_queue(submission_id) WHERE submission_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS nav_invoice_queue_due_idx
  ON nav_invoice_queue(status,next_attempt_at,created_at);

-- A korábbi 'processing' sorok deploy/restart után ne ragadjanak be örökre.
UPDATE nav_invoice_queue
SET status='queued',
    next_attempt_at=now(),
    last_error=COALESCE(last_error,'Worker újraindítás után visszaállítva a feldolgozási sorba.'),
    updated_at=now()
WHERE status='processing' AND updated_at < now()-interval '10 minutes';
