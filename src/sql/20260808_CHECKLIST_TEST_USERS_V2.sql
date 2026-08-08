BEGIN;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_name text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash text;

-- Egyszerű, egyértelmű tesztbelépések. A plaintext jelszó nincs adatbázisban tárolva,
-- kizárólag az alábbi bcrypt hash-ek kerülnek mentésre.
UPDATE employees SET
  login_name='recepcio1',
  password_hash='$2b$12$7PUMLG2LNzYtDs1xShsbvOUOA/W2hO7FpKhDmQ.7ub1c9ZYdznG1y',
  role='["receptionist"]'::jsonb,
  updated_at=now()
WHERE lower(email)='demo.reka.molnar@kleoszalon.hu';

UPDATE employees SET
  login_name='recepcio2',
  password_hash='$2b$12$RrZlzqtFwrWgHPgHK397.eRdHDbRe9gpUb6oqfsrvwG/sEAIhFDsC',
  role='["receptionist"]'::jsonb,
  updated_at=now()
WHERE lower(email)='demo.maria.fekete@kleoszalon.hu';

UPDATE employees SET
  login_name='kozmetikus1',
  password_hash='$2b$12$aI0qW6QSy88lWI6vgvY5HuHBwg5wTviyZo8PnVtxDYjcGyGKzhCrq',
  role='["employee"]'::jsonb,
  updated_at=now()
WHERE lower(email)='demo.julia.szabo@kleoszalon.hu';

UPDATE employees SET
  login_name='kozmetikus2',
  password_hash='$2b$12$FbX9ivhjtQskbOInFpQOm.HhRfP3gFWs19VmhHxmr6i1j1wBkEM8q',
  role='["employee"]'::jsonb,
  updated_at=now()
WHERE lower(email)='demo.dorottya.farkas@kleoszalon.hu';

INSERT INTO schema_migrations(version,description)
VALUES('20260808_CHECKLIST_TEST_USERS_V2','Egyszerű munkatársi teszt felhasználónevek és jelszavak')
ON CONFLICT(version) DO NOTHING;

COMMIT;
