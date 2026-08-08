BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS login_name text;

-- A tesztjelszavak plaintext változata nincs az adatbázis-migrációban tárolva.
-- A bcrypt hash-ekhez tartozó belépési adatokat a fejlesztési átadás tartalmazza.

UPDATE employees SET
  login_name='demo_reka',
  password_hash='$2b$12$x39iVj2TL/i3ZQAzLPLc8upgxBRQr4CInF54oNzQb9mF52WQAHMSi',
  role='["receptionist"]'::jsonb,
  updated_at=now()
WHERE lower(email)='demo.reka.molnar@kleoszalon.hu';

UPDATE employees SET
  login_name='demo_maria',
  password_hash='$2b$12$4MnefaMuY1aM6Se6rEN3cO2a./15d.BfLzI7Jk6Ap4NBCdgtb1zau',
  role='["receptionist"]'::jsonb,
  updated_at=now()
WHERE lower(email)='demo.maria.fekete@kleoszalon.hu';

UPDATE employees SET
  login_name='demo_julia',
  password_hash='$2b$12$3qd3aJB6zjRgEyXva3budOYSHFmVqc6CfXEhEOQpF0ASEJ2xdQ//e',
  role='["employee"]'::jsonb,
  updated_at=now()
WHERE lower(email)='demo.julia.szabo@kleoszalon.hu';

UPDATE employees SET
  login_name='demo_dorottya',
  password_hash='$2b$12$w.QAUtQESmobk0EcNB2jm.c0UcrCfuL4OnDeS1QltdWS8AG3fKE3G',
  role='["employee"]'::jsonb,
  updated_at=now()
WHERE lower(email)='demo.dorottya.farkas@kleoszalon.hu';

-- A users.role több régi telepítésen text, egyes környezetekben json/jsonb lehet.
-- Dinamikus SQL-lel mindkét sémát támogatjuk.
DO $$
DECLARE
  role_udt text;
  r record;
  role_value text;
BEGIN
  SELECT udt_name INTO role_udt
  FROM information_schema.columns
  WHERE table_schema=current_schema() AND table_name='users' AND column_name='role'
  LIMIT 1;

  FOR r IN
    SELECT * FROM (VALUES
      ('DEMO Molnár Réka','demo.reka.molnar@kleoszalon.hu','$2b$12$x39iVj2TL/i3ZQAzLPLc8upgxBRQr4CInF54oNzQb9mF52WQAHMSi','receptionist'),
      ('DEMO Fekete Mária','demo.maria.fekete@kleoszalon.hu','$2b$12$4MnefaMuY1aM6Se6rEN3cO2a./15d.BfLzI7Jk6Ap4NBCdgtb1zau','receptionist'),
      ('DEMO Szabó Júlia','demo.julia.szabo@kleoszalon.hu','$2b$12$3qd3aJB6zjRgEyXva3budOYSHFmVqc6CfXEhEOQpF0ASEJ2xdQ//e','employee'),
      ('DEMO Farkas Dorottya','demo.dorottya.farkas@kleoszalon.hu','$2b$12$w.QAUtQESmobk0EcNB2jm.c0UcrCfuL4OnDeS1QltdWS8AG3fKE3G','employee')
    ) AS v(full_name,email,password_hash,role_key)
  LOOP
    IF role_udt IN ('json','jsonb') THEN
      role_value := to_json(r.role_key::text)::text;
      EXECUTE 'UPDATE users SET full_name=$1,password_hash=$2,role=$3::jsonb WHERE lower(email)=lower($4)'
        USING r.full_name,r.password_hash,role_value,r.email;
      IF NOT FOUND THEN
        EXECUTE 'INSERT INTO users(full_name,email,password_hash,role) VALUES($1,$2,$3,$4::jsonb)'
          USING r.full_name,r.email,r.password_hash,role_value;
      END IF;
    ELSE
      UPDATE users SET full_name=r.full_name,password_hash=r.password_hash,role=r.role_key
      WHERE lower(email)=lower(r.email);
      IF NOT FOUND THEN
        INSERT INTO users(full_name,email,password_hash,role)
        VALUES(r.full_name,r.email,r.password_hash,r.role_key);
      END IF;
    END IF;
  END LOOP;
END $$;

-- Rövid, általános munkatársi checklist a nem recepciós teszthez.
INSERT INTO vir_checklists(code,name,description,daily_warning_time,weekly_warning_weekday,monthly_warning_days,is_active)
VALUES(
  'employee-core-demo-v1',
  'Munkatársi alap check lista',
  'Általános munkatársi próba-checklista a napi, heti és havi feladatkezelés teszteléséhez.',
  '18:00',3,7,true
)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  description=EXCLUDED.description,
  daily_warning_time=EXCLUDED.daily_warning_time,
  weekly_warning_weekday=EXCLUDED.weekly_warning_weekday,
  monthly_warning_days=EXCLUDED.monthly_warning_days,
  is_active=true,
  updated_at=now();

WITH c AS (SELECT id FROM vir_checklists WHERE code='employee-core-demo-v1')
INSERT INTO vir_checklist_items(checklist_id,item_key,frequency,section,title,sort_order,is_required,is_active)
SELECT c.id,v.item_key,v.frequency,v.section,v.title,v.sort_order,true,true
FROM c CROSS JOIN (VALUES
  ('daily-001','daily','Munkakezdés','Munkaterület és eszközök előkészítése',10),
  ('daily-002','daily','Munkakezdés','Napi vendéglista és időpontok áttekintése',20),
  ('daily-003','daily','Munkavégzés','Higiéniai és fertőtlenítési előírások ellenőrzése',30),
  ('daily-004','daily','Munkavégzés','Felhasznált anyagok és termékek rögzítése',40),
  ('daily-005','daily','Zárás','Munkaterület rendbetétele és napi eltérések jelzése',50),
  ('weekly-001','weekly','Heti feladatok','Eszközök, fogyóanyagok és készlethiányok ellenőrzése',10),
  ('weekly-002','weekly','Heti feladatok','Munkaterület részletes heti higiéniai ellenőrzése',20),
  ('monthly-001','monthly','Havi feladatok','Lejárati idők és szakmai készletek havi ellenőrzése',10),
  ('monthly-002','monthly','Havi feladatok','Havi szakmai önértékelés és fejlesztési igények rögzítése',20)
) AS v(item_key,frequency,section,title,sort_order)
ON CONFLICT(checklist_id,item_key) DO UPDATE SET
  frequency=EXCLUDED.frequency,
  section=EXCLUDED.section,
  title=EXCLUDED.title,
  sort_order=EXCLUDED.sort_order,
  is_required=true,
  is_active=true,
  updated_at=now();

WITH c AS (SELECT id FROM vir_checklists WHERE code='employee-core-demo-v1')
INSERT INTO vir_checklist_position_assignments(checklist_id,position_id,is_active)
SELECT c.id,p.id,true
FROM c
JOIN hr_positions p ON lower(COALESCE(p.code,''))='demo-kozmet'
   OR lower(COALESCE(p.name,'')) LIKE '%kozmetikus%'
ON CONFLICT(checklist_id,position_id) DO UPDATE SET is_active=true,updated_at=now();

INSERT INTO schema_migrations(version,description)
VALUES('20260808_CHECKLIST_TEST_USERS_V1','Jelszavas DEMO recepciós és munkatársi tesztfiókok + munkatársi próba-checklista')
ON CONFLICT(version) DO NOTHING;

COMMIT;
