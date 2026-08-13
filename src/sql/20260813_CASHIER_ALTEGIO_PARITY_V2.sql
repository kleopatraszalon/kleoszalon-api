BEGIN;

-- PostgreSQL 16 a manuális kasszaművelet ugyanazon paraméterét nem engedi
-- egyszerre varchar és text oszlophoz következtetni. A reason_code üzleti kód,
-- ezért a korlátlan text típus megfelelő és egységes a transaction_type_code-dal.
ALTER TABLE cash_register_movements
  ALTER COLUMN reason_code TYPE text USING reason_code::text;

COMMIT;
