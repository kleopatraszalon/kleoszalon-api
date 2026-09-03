BEGIN;

-- PostgreSQL 16 a manuális kasszaművelet ugyanazon paraméterét nem engedi
-- egyszerre varchar és text oszlophoz következtetni. A reason_code üzleti kód,
-- ezért a korlátlan text típus megfelelő és egységes a transaction_type_code-dal.
ALTER TABLE cash_register_movements
  ALTER COLUMN reason_code TYPE text USING reason_code::text;

-- A pénztári műszak táblát korábbi live verziók egy szűkebb oszlopkészlettel
-- hozták létre. A CREATE TABLE IF NOT EXISTS a már létező táblát nem bővíti,
-- miközben a jelenlegi /cashier/shift/open már az alábbi mezőket használja.
-- A bootstrap ezért in-place kompatibilissé teszi a régi adatbázisokat is.
CREATE TABLE IF NOT EXISTS cash_register_shifts (
  id bigserial PRIMARY KEY,
  location_id text NOT NULL,
  location_name text,
  business_date date,
  status varchar(24) NOT NULL DEFAULT 'open',
  opening_cash numeric(14,2) NOT NULL DEFAULT 0,
  opening_note text,
  opened_by text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  current_cashier text,
  closed_by text,
  closed_at timestamptz,
  closing_id bigint,
  report_no text,
  close_note text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE cash_register_shifts
  ADD COLUMN IF NOT EXISTS location_name text,
  ADD COLUMN IF NOT EXISTS business_date date,
  ADD COLUMN IF NOT EXISTS opening_note text,
  ADD COLUMN IF NOT EXISTS current_cashier text,
  ADD COLUMN IF NOT EXISTS closed_by text,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS closing_id bigint,
  ADD COLUMN IF NOT EXISTS report_no text,
  ADD COLUMN IF NOT EXISTS close_note text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Régi műszakoknál a business_date/current_cashier nem létezett. A meglévő
-- opened_at/opened_by adatokból biztonságosan visszatölthetők anélkül, hogy
-- a pénzügyi előzményeket átírnánk.
UPDATE cash_register_shifts
SET business_date = COALESCE(business_date, opened_at::date, CURRENT_DATE)
WHERE business_date IS NULL;

UPDATE cash_register_shifts
SET current_cashier = COALESCE(NULLIF(current_cashier,''), NULLIF(opened_by,''), 'legacy')
WHERE current_cashier IS NULL OR current_cashier='';

ALTER TABLE cash_register_shifts
  ALTER COLUMN business_date SET DEFAULT CURRENT_DATE;

CREATE INDEX IF NOT EXISTS cash_register_shifts_history_idx
  ON cash_register_shifts (location_id,business_date DESC,opened_at DESC);

COMMIT;
