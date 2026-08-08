BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS vir_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  daily_warning_time time NOT NULL DEFAULT '18:00',
  weekly_warning_weekday smallint NOT NULL DEFAULT 3 CHECK (weekly_warning_weekday BETWEEN 1 AND 7),
  monthly_warning_days smallint NOT NULL DEFAULT 7 CHECK (monthly_warning_days BETWEEN 1 AND 31),
  is_active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS vir_checklist_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_id uuid NOT NULL REFERENCES vir_checklists(id) ON DELETE CASCADE,
  item_key text NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  section text,
  title text NOT NULL,
  description text,
  sort_order integer NOT NULL DEFAULT 0,
  is_required boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(checklist_id,item_key)
);
CREATE INDEX IF NOT EXISTS vir_checklist_items_checklist_idx
  ON vir_checklist_items(checklist_id,frequency,is_active,sort_order);

CREATE TABLE IF NOT EXISTS vir_checklist_position_assignments (
  checklist_id uuid NOT NULL REFERENCES vir_checklists(id) ON DELETE CASCADE,
  position_id uuid NOT NULL REFERENCES hr_positions(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(checklist_id,position_id)
);
CREATE INDEX IF NOT EXISTS vir_checklist_position_idx
  ON vir_checklist_position_assignments(position_id,is_active);

CREATE TABLE IF NOT EXISTS vir_checklist_completions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checklist_item_id uuid NOT NULL REFERENCES vir_checklist_items(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  completed boolean NOT NULL DEFAULT true,
  completed_at timestamptz,
  completed_by_user_id text,
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(checklist_item_id,employee_id,period_start)
);
CREATE INDEX IF NOT EXISTS vir_checklist_completion_lookup_idx
  ON vir_checklist_completions(employee_id,period_start,completed);

INSERT INTO vir_checklists(code,name,description,daily_warning_time,weekly_warning_weekday,monthly_warning_days,is_active)
VALUES (
  'receptionist-core-v1',
  'Recepciós csekklista',
  'A recepciós csekklista célja a hibamentes működés, bevételmaximalizálás és vendégélmény biztosítása. A lista minden kötelező pontja elvégzendő.',
  '18:00',3,7,true
)
ON CONFLICT(code) DO NOTHING;

WITH c AS (SELECT id FROM vir_checklists WHERE code='receptionist-core-v1')
INSERT INTO vir_checklist_items(checklist_id,item_key,frequency,section,title,sort_order,is_required,is_active)
SELECT c.id,v.item_key,v.frequency,v.section,v.title,v.sort_order,true,true
FROM c
CROSS JOIN (VALUES
  ('daily-001','daily','Nyitáskor','Kassza nyitás, váltópénz ellenőrzése',10),
  ('daily-002','daily','Nyitáskor','Jelenléti ív aláírása',20),
  ('daily-003','daily','Nyitáskor','Rendszerek megnyitása (időpontkezelő, kasszák, terminálok, e-mail, Facebook, zene)',30),
  ('daily-004','daily','Nyitáskor','Nem fogadott hívások ellenőrzése és visszahívása',40),
  ('daily-005','daily','Nyitáskor','Jelenlétek és felkészültség ellenőrzése (megérkezés, munkára kész állapot, dress code)',50),
  ('daily-006','daily','Nyitáskor','Napi beosztás és szabad idősávok áttekintése',60),
  ('daily-007','daily','Nyitáskor','Kihasználtság ellenőrzése, időpontok összerendezése',70),
  ('daily-008','daily','Nyitáskor','70%-os foglaltság ellenőrzése',80),
  ('daily-009','daily','Műszak közben – Bevétel és kihasználtság','Bevételi terv folyamatos figyelése a műszak alatt',90),
  ('daily-010','daily','Műszak közben – Bevétel és kihasználtság','SMS-ek küldése a mai vendégeknek cross-sell ajánlattal',100),
  ('daily-011','daily','Műszak közben – Bevétel és kihasználtság','Üres idősávok feltöltése',110),
  ('daily-012','daily','Műszak közben – Bevétel és kihasználtság','Kosárérték növelése',120),
  ('daily-013','daily','Műszak közben – Bevétel és kihasználtság','UPSELL – minden vendégnél ajánlás megtörtént (Beauty+, kiegészítő szolgáltatások)',130),
  ('daily-014','daily','Műszak közben – Bevétel és kihasználtság','CROSSELL – ajánlás szabad időpontokra, cross-sell kártyák használatával',140),
  ('daily-015','daily','Műszak közben – Bevétel és kihasználtság','Következő időpont felajánlása minden vendégnél',150),
  ('daily-016','daily','Műszak közben – Bevétel és kihasználtság','Utalvány / bérlet / vendégszámla / termék értékesítése',160),
  ('daily-017','daily','Vendégkezelés','Telefonkezelés legfeljebb 3 csörgésen belül',170),
  ('daily-018','daily','Vendégkezelés','Facebook-üzenetek megválaszolása',180),
  ('daily-019','daily','Vendégkezelés','Vendégek fogadása, irányítása, minden vendég elvállalása',190),
  ('daily-020','daily','Vendégkezelés','Lemondások azonnali pótlása',200),
  ('daily-021','daily','Vendégkezelés','Mobilapplikáció letöltésének felajánlása',210),
  ('daily-022','daily','Vendégkezelés','Hűségkártya (Kleo Card) kiadása új vendégeknek',220),
  ('daily-023','daily','Vendégkezelés','Hírlevél-feliratkozás felajánlása',230),
  ('daily-024','daily','Vendégkezelés','Google-értékelés kérése elégedett vendégektől',240),
  ('daily-025','daily','Vendégkezelés','Holnapi vendégek cross-sell ajánlata és időpont-megerősítése',250),
  ('daily-026','daily','Vendégkezelés','Elveszett vendégek hívása',260),
  ('daily-027','daily','Operatív működés','Szolgáltatások és termékek pontos rögzítése',270),
  ('daily-028','daily','Operatív működés','Nyugtaadás minden fizetésnél',280),
  ('daily-029','daily','Operatív működés','Nyugtaösszesítő pontos kitöltése',290),
  ('daily-030','daily','Operatív működés','Kasszarend betartása (kasszaátadás, műszakváltáskor áthelyezések)',300),
  ('daily-031','daily','Operatív működés','Felhasznált alapanyagok rögzítése',310),
  ('daily-032','daily','Operatív működés','Készlet és érkező áru bevételezése',320),
  ('daily-033','daily','Operatív működés','Házirend és Etikai kódex betartása',330),
  ('daily-034','daily','Operatív működés','Tisztaság és higiénia ellenőrzése',340),
  ('daily-035','daily','Operatív működés','Pultrend fenntartása',350),
  ('daily-036','daily','Záráskor','Kasszazárás, egyezőség ellenőrzése (nyugtaösszesítő és szoftver)',360),
  ('daily-037','daily','Záráskor','Napi bevétel rögzítése az elvárt napi táblázatban',370),
  ('daily-038','daily','Záráskor','Csekklista kitöltése',380),
  ('daily-039','daily','Záráskor','Problémák, eltérések dokumentálása és jelentés küldése',390),
  ('daily-040','daily','Záráskor','Takarítási feladatok, fűtés, klíma, világítás és ablakok ellenőrzése',400),
  ('weekly-001','weekly','Heti feladatok','Heti bevételi és értékesítési számok áttekintése',10),
  ('weekly-002','weekly','Heti feladatok','Elvesztett vendégek visszahívása',20),
  ('weekly-003','weekly','Heti feladatok','Heti Google-értékelések ellenőrzése',30),
  ('weekly-004','weekly','Heti feladatok','Heti app-letöltések és hírlevél-feliratkozások összesítése',40),
  ('weekly-005','weekly','Heti feladatok','Jelzett problémák egyeztetése a szalonvezetővel',50),
  ('monthly-001','monthly','Havi feladatok','Havi recepciós értékesítési minimum teljesítése',10),
  ('monthly-002','monthly','Havi feladatok','Utalvány + bérlet KPI ellenőrzése',20),
  ('monthly-003','monthly','Havi feladatok','Google-értékelési cél elérése (minimum 10 db)',30),
  ('monthly-004','monthly','Havi feladatok','Hűségkártyák számának ellenőrzése',40),
  ('monthly-005','monthly','Havi feladatok','App-letöltések és hírlevél-feliratkozások összesítése',50),
  ('monthly-006','monthly','Havi feladatok','Havi önértékelés elkészítése',60),
  ('monthly-007','monthly','Havi feladatok','Teljesítmény egyeztetése a vezetővel',70)
) AS v(item_key,frequency,section,title,sort_order)
ON CONFLICT(checklist_id,item_key) DO NOTHING;

WITH c AS (SELECT id FROM vir_checklists WHERE code='receptionist-core-v1')
INSERT INTO vir_checklist_position_assignments(checklist_id,position_id,is_active)
SELECT c.id,p.id,true
FROM c
JOIN hr_positions p ON COALESCE(p.is_active,true)=true
WHERE lower(COALESCE(p.name,'')) LIKE '%recepc%'
   OR lower(COALESCE(p.code,'')) LIKE '%recep%'
ON CONFLICT(checklist_id,position_id) DO NOTHING;

INSERT INTO schema_migrations(version,description)
VALUES ('20260808_CHECKLISTS_V1','Tudásbázis check listák: munkakör-hozzárendelés, napi/heti/havi teljesítés és figyelmeztetések')
ON CONFLICT(version) DO NOTHING;

COMMIT;
