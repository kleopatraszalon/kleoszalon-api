BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- KLEOSZALON DEMO ADATOK – teszteléshez, többször futtatható
-- Minden létrehozott adat DEMO jelölést vagy demo.kleoszalon.hu címet kap.
-- ============================================================

-- A két régebbi munkatársi kiegészítő tábla nem minden telepítésen került
-- automatikusan létrehozásra. A seed önállóan is gondoskodik róluk.
CREATE TABLE IF NOT EXISTS employee_wage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id text NOT NULL,
  monthly_wage numeric(12,2),
  hourly_wage numeric(12,2),
  commission_percent numeric(5,2),
  valid_from date NOT NULL DEFAULT CURRENT_DATE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS employee_service_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id text NOT NULL,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  custom_price numeric(12,2),
  custom_duration_minutes integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
DELETE FROM employee_service_overrides older
USING employee_service_overrides newer
WHERE older.employee_id=newer.employee_id
  AND older.service_id=newer.service_id
  AND older.ctid < newer.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS employee_service_overrides_employee_service_uq
  ON employee_service_overrides(employee_id,service_id);

INSERT INTO locations(name,address,city,phone,email,is_active)
SELECT v.name,v.address,v.city,v.phone,v.email,true
FROM (VALUES
 ('DEMO – Kleopátra Eger','Dr. Nagy János utca 8.','Eger','+36 30 303 8262','demo.eger@kleoszalon.hu'),
 ('DEMO – Kleopátra Salgótarján','Füleki út 44.','Salgótarján','+36 30 248 0544','demo.salgotarjan@kleoszalon.hu'),
 ('DEMO – KLEOSZALON MEN','Visegrádi utca 7.','Budapest','+36 30 555 0707','demo.men@kleoszalon.hu')
) v(name,address,city,phone,email)
WHERE NOT EXISTS(SELECT 1 FROM locations l WHERE lower(l.email)=lower(v.email));

INSERT INTO hr_positions(code,name,description,department_name,management_level,base_monthly_wage,base_hourly_wage,commission_percent,is_active)
SELECT * FROM (VALUES
 ('DEMO-SZALONVEZ','Szalonvezető','Telephelyi működés, csapat és minőség irányítása.','Vezetés',3,650000::numeric,3800::numeric,1.5::numeric,true),
 ('DEMO-MUSZAKVEZ','Műszakvezető','Napi műszak koordinálása és pénztárzárás.','Vezetés',2,520000,3100,1,true),
 ('DEMO-RECEPCIO','Recepciós','Vendégfogadás, időpontkezelés és pénztár.','Ügyfélkapcsolat',1,420000,2500,0.5,true),
 ('DEMO-FODRASZ','Fodrász','Női és férfi hajvágás, festés és hajkezelések.','Fodrászat',0,360000,2300,12,true),
 ('DEMO-TOPFOD','TOP fodrász','Prémium hajkezelések és szakmai mentorálás.','Fodrászat',1,480000,3000,15,true),
 ('DEMO-BORBELY','Borbély','Férfi hajvágás, szakállápolás és borotválás.','Fodrászat',0,350000,2250,12,true),
 ('DEMO-KOZMET','Kozmetikus','Arc-, bőrfiatalító és esztétikai kezelések.','Kozmetika',0,390000,2500,14,true),
 ('DEMO-KORMOS','Kéz- és lábápoló','Manikűr, pedikűr, géllakk és paraffinos ápolás.','Körömápolás',0,350000,2250,13,true),
 ('DEMO-MASSZOR','Masszőr','Frissítő, relaxáló és wellness masszázsok.','Masszázs',0,360000,2400,14,true),
 ('DEMO-SZOLARIUM','Szolárium kezelő','Vendégirányítás, gépek előkészítése és higiénia.','Szolárium',0,330000,2100,2,true),
 ('DEMO-OKTATO','Szakmai oktató','Kleo Academy workshopok és szakmai integráció.','Oktatás',2,580000,4000,5,true),
 ('DEMO-RAKTAR','Készlet- és beszerzési munkatárs','Kozmetikai anyagok, termékek és eszközök kezelése.','Logisztika',0,410000,2450,0,true)
) v(code,name,description,department_name,management_level,base_monthly_wage,base_hourly_wage,commission_percent,is_active)
WHERE NOT EXISTS(SELECT 1 FROM hr_positions p WHERE lower(p.code)=lower(v.code));

INSERT INTO compensation_plans(name,code,description,calculation_mode,monthly_base,hourly_rate,daily_rate,shift_rate,service_commission_percent,product_commission_percent,revenue_commission_percent,attendance_bonus,target_bonus,monthly_target,overtime_multiplier,weekend_multiplier,evening_multiplier,night_multiplier,paid_leave_multiplier,holiday_multiplier,rounding_minutes,minimum_guarantee,maximum_gross,currency,is_active)
SELECT * FROM (VALUES
 ('DEMO – Vezetői csomag','DEMO-MANAGER','Havi vezetői alap, forgalmi prémium és célbónusz.','monthly_plus_variable',650000::numeric,3800::numeric,0::numeric,0::numeric,0::numeric,2::numeric,1.5::numeric,40000::numeric,100000::numeric,8000000::numeric,1.5::numeric,1.25::numeric,1.15::numeric,1.20::numeric,1::numeric,2::numeric,15,650000::numeric,1200000::numeric,'HUF',true),
 ('DEMO – Recepció','DEMO-RECEPTION','Havi alap és jelenléti prémium.','monthly_plus_variable',420000,2500,0,0,0,0.5,0.25,25000,30000,3500000,1.5,1.25,1.15,1.20,1,2,15,420000,650000,'HUF',true),
 ('DEMO – Fodrász jutalékos','DEMO-HAIR','Alapbér szolgáltatási és termékjutalékkal.','monthly_plus_variable',360000,2300,0,0,12,8,1,20000,60000,2500000,1.5,1.30,1.20,1.25,1,2,15,360000,1100000,'HUF',true),
 ('DEMO – Kozmetikus jutalékos','DEMO-BEAUTY','Kozmetikai kezelésekhez magasabb szolgáltatási jutalék.','monthly_plus_variable',390000,2500,0,0,14,10,1,20000,70000,2200000,1.5,1.30,1.20,1.25,1,2,15,390000,1100000,'HUF',true),
 ('DEMO – Órabéres részmunkaidő','DEMO-HOURLY','Részmunkaidős és diák foglalkoztatás.','hourly_only',0,2200,18000,0,5,3,0,12000,20000,900000,1.5,1.30,1.20,1.25,1,2,15,0,550000,'HUF',true),
 ('DEMO – Oktatói csomag','DEMO-TRAINER','Havi alap, workshop napidíj és célprémium.','higher_of',580000,4000,45000,0,5,5,1,25000,80000,1800000,1.5,1.25,1.15,1.20,1,2,15,580000,1200000,'HUF',true)
) v(name,code,description,calculation_mode,monthly_base,hourly_rate,daily_rate,shift_rate,service_commission_percent,product_commission_percent,revenue_commission_percent,attendance_bonus,target_bonus,monthly_target,overtime_multiplier,weekend_multiplier,evening_multiplier,night_multiplier,paid_leave_multiplier,holiday_multiplier,rounding_minutes,minimum_guarantee,maximum_gross,currency,is_active)
WHERE NOT EXISTS(SELECT 1 FROM compensation_plans p WHERE lower(p.code)=lower(v.code));

INSERT INTO employees(full_name,first_name,last_name,email,phone,birth_date,qualification,employment_type,location_id,position_id,monthly_wage,hourly_wage,commission_percent,active,login_name,password_hash,role,photo_url)
SELECT v.full_name,v.first_name,v.last_name,v.email,v.phone,v.birth_date::date,v.qualification,v.employment_type,l.id,p.id,v.monthly_wage,v.hourly_wage,v.commission_percent,true,v.login_name,NULL,v.role::jsonb,NULL
FROM (VALUES
 ('DEMO Kovács Anna','Anna','Kovács','demo.anna.kovacs@kleoszalon.hu','+36 30 700 1001','1988-04-12','Mesterfodrász, szalonmenedzser','full_time_indefinite','demo.eger@kleoszalon.hu','DEMO-SZALONVEZ',650000::numeric,3800::numeric,1.5::numeric,'demo_anna','["manager"]'),
 ('DEMO Nagy Eszter','Eszter','Nagy','demo.eszter.nagy@kleoszalon.hu','+36 30 700 1002','1992-07-21','Fodrász szakoktató','full_time_indefinite','demo.eger@kleoszalon.hu','DEMO-TOPFOD',480000,3000,15,'demo_eszter','["employee"]'),
 ('DEMO Szabó Júlia','Júlia','Szabó','demo.julia.szabo@kleoszalon.hu','+36 30 700 1003','1995-02-08','Kozmetikus technikus','full_time_indefinite','demo.eger@kleoszalon.hu','DEMO-KOZMET',390000,2500,14,'demo_julia','["employee"]'),
 ('DEMO Tóth Petra','Petra','Tóth','demo.petra.toth@kleoszalon.hu','+36 30 700 1004','1998-11-18','Kéz- és lábápoló technikus','full_time_fixed','demo.eger@kleoszalon.hu','DEMO-KORMOS',350000,2250,13,'demo_petra','["employee"]'),
 ('DEMO Horváth Leila','Leila','Horváth','demo.leila.horvath@kleoszalon.hu','+36 30 700 1005','1990-06-04','Gyógymasszőr','part_time_indefinite','demo.eger@kleoszalon.hu','DEMO-MASSZOR',0,2400,14,'demo_leila','["employee"]'),
 ('DEMO Kiss Kamilla','Kamilla','Kiss','demo.kamilla.kiss@kleoszalon.hu','+36 30 700 2001','1987-09-14','Szalonvezető','full_time_indefinite','demo.salgotarjan@kleoszalon.hu','DEMO-SZALONVEZ',650000,3800,1.5,'demo_kamilla','["manager"]'),
 ('DEMO Varga Brigitta','Brigitta','Varga','demo.brigitta.varga@kleoszalon.hu','+36 30 700 2002','1993-03-26','Fodrász','full_time_indefinite','demo.salgotarjan@kleoszalon.hu','DEMO-FODRASZ',360000,2300,12,'demo_brigitta','["employee"]'),
 ('DEMO Farkas Dorottya','Dorottya','Farkas','demo.dorottya.farkas@kleoszalon.hu','+36 30 700 2003','1997-12-02','Kozmetikus','probation','demo.salgotarjan@kleoszalon.hu','DEMO-KOZMET',390000,2500,14,'demo_dorottya','["employee"]'),
 ('DEMO Molnár Réka','Réka','Molnár','demo.reka.molnar@kleoszalon.hu','+36 30 700 2004','2001-05-30','Recepciós és ügyfélkapcsolati munkatárs','part_time_fixed','demo.salgotarjan@kleoszalon.hu','DEMO-RECEPCIO',0,2200,0.5,'demo_reka','["receptionist"]'),
 ('DEMO Balogh László','László','Balogh','demo.laszlo.balogh@kleoszalon.hu','+36 30 700 3001','1989-08-17','Mesterborbély','full_time_indefinite','demo.men@kleoszalon.hu','DEMO-BORBELY',350000,2250,12,'demo_laszlo','["employee"]'),
 ('DEMO Pál Gábor','Gábor','Pál','demo.gabor.pal@kleoszalon.hu','+36 30 700 3002','1994-01-11','Férfi fodrász, szakállspecialista','full_time_indefinite','demo.men@kleoszalon.hu','DEMO-TOPFOD',480000,3000,15,'demo_gabor','["employee"]'),
 ('DEMO Fekete Mária','Mária','Fekete','demo.maria.fekete@kleoszalon.hu','+36 30 700 3003','1999-10-09','Recepciós','student','demo.men@kleoszalon.hu','DEMO-RECEPCIO',0,2200,0.5,'demo_maria','["receptionist"]')
) v(full_name,first_name,last_name,email,phone,birth_date,qualification,employment_type,location_email,position_code,monthly_wage,hourly_wage,commission_percent,login_name,role)
JOIN locations l ON lower(l.email)=lower(v.location_email)
JOIN hr_positions p ON lower(p.code)=lower(v.position_code)
WHERE NOT EXISTS(SELECT 1 FROM employees e WHERE lower(e.email)=lower(v.email));

INSERT INTO employee_position_assignments(employee_id,position_id,location_id,is_primary,weekly_hours,valid_from,is_active)
SELECT e.id,e.position_id,e.location_id,true,CASE WHEN e.employment_type LIKE 'part_time%' OR e.employment_type='student' THEN 20 ELSE 40 END,DATE '2026-01-01',true
FROM employees e WHERE e.email LIKE 'demo.%@kleoszalon.hu' AND e.position_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO employment_contracts(employee_id,employment_type_id,contract_number,start_date,end_date,probation_end_date,weekly_hours,work_schedule_type,cost_center,tax_category,notes,is_active)
SELECT e.id,t.id,'DEMO-'||upper(substr(replace(e.id::text,'-',''),1,10)),DATE '2026-01-01',CASE WHEN e.employment_type IN('full_time_fixed','part_time_fixed') THEN DATE '2026-12-31' ELSE NULL END,CASE WHEN e.employment_type='probation' THEN DATE '2026-09-30' ELSE NULL END,CASE WHEN e.employment_type LIKE 'part_time%' OR e.employment_type='student' THEN 20 ELSE 40 END,'flexible','DEMO-'||COALESCE(l.city,'SZALON'),'normal','DEMO tesztszerződés – nem valós foglalkoztatási adat.',true
FROM employees e JOIN employment_types t ON lower(t.code)=lower(e.employment_type) LEFT JOIN locations l ON l.id=e.location_id
WHERE e.email LIKE 'demo.%@kleoszalon.hu' AND NOT EXISTS(SELECT 1 FROM employment_contracts c WHERE c.employee_id=e.id AND c.contract_number LIKE 'DEMO-%');

INSERT INTO employee_compensation_assignments(employee_id,compensation_plan_id,monthly_base,hourly_rate,daily_rate,service_commission_percent,product_commission_percent,revenue_commission_percent,valid_from,reason,is_active)
SELECT e.id,p.id,NULL,NULL,NULL,NULL,NULL,NULL,DATE '2026-01-01','DEMO bércsomag hozzárendelés',true
FROM employees e JOIN compensation_plans p ON p.code=CASE
 -- A role oszlop a regi adatbazisokban text, az uj telepiteseken jsonb lehet.
 -- A szoveges osszehasonlitas mindket semaval kompatibilis.
 WHEN lower(COALESCE(e.role::text,'')) LIKE '%manager%' THEN 'DEMO-MANAGER'
 WHEN e.position_id=(SELECT id FROM hr_positions WHERE code='DEMO-RECEPCIO') THEN 'DEMO-RECEPTION'
 WHEN e.position_id IN(SELECT id FROM hr_positions WHERE code IN('DEMO-KOZMET','DEMO-KORMOS','DEMO-MASSZOR')) THEN 'DEMO-BEAUTY'
 WHEN e.position_id=(SELECT id FROM hr_positions WHERE code='DEMO-OKTATO') THEN 'DEMO-TRAINER'
 WHEN e.employment_type IN('part_time_indefinite','part_time_fixed','student') THEN 'DEMO-HOURLY'
 ELSE 'DEMO-HAIR' END
WHERE e.email LIKE 'demo.%@kleoszalon.hu'
ON CONFLICT DO NOTHING;

INSERT INTO employee_wage_history(employee_id,monthly_wage,hourly_wage,commission_percent,valid_from,note)
SELECT e.id,e.monthly_wage,e.hourly_wage,e.commission_percent,DATE '2026-01-01','DEMO kezdő bérezés'
FROM employees e WHERE e.email LIKE 'demo.%@kleoszalon.hu' AND NOT EXISTS(SELECT 1 FROM employee_wage_history w WHERE w.employee_id::text=e.id::text AND w.note='DEMO kezdő bérezés');

INSERT INTO employee_service_overrides(employee_id,service_id,custom_price,custom_duration_minutes)
SELECT e.id,s.id,NULL,NULL FROM employees e CROSS JOIN LATERAL(SELECT id FROM services ORDER BY name LIMIT 3)s
WHERE e.email LIKE 'demo.%@kleoszalon.hu' AND e.position_id IN(SELECT id FROM hr_positions WHERE code IN('DEMO-FODRASZ','DEMO-TOPFOD','DEMO-BORBELY','DEMO-KOZMET','DEMO-KORMOS','DEMO-MASSZOR'))
ON CONFLICT(employee_id,service_id) DO NOTHING;

INSERT INTO commission_rules(compensation_plan_id,position_id,rule_type,calculation_type,value,threshold_from,threshold_to,valid_from,is_active)
SELECT p.id,h.id,v.rule_type,v.calculation_type,v.value,v.threshold_from,v.threshold_to,DATE '2026-01-01',true
FROM (VALUES
 ('DEMO-HAIR','DEMO-FODRASZ','service','percent',12::numeric,0::numeric,1500000::numeric),
 ('DEMO-HAIR','DEMO-TOPFOD','service','percent',15,1500000,3000000),
 ('DEMO-BEAUTY','DEMO-KOZMET','service','percent',14,0,2200000),
 ('DEMO-BEAUTY','DEMO-KORMOS','product','percent',10,0,1000000),
 ('DEMO-MANAGER','DEMO-SZALONVEZ','revenue','percent',1.5,5000000,10000000)
)v(plan_code,position_code,rule_type,calculation_type,value,threshold_from,threshold_to)
JOIN compensation_plans p ON p.code=v.plan_code JOIN hr_positions h ON h.code=v.position_code
WHERE NOT EXISTS(SELECT 1 FROM commission_rules r WHERE r.compensation_plan_id=p.id AND r.position_id=h.id AND r.rule_type=v.rule_type AND r.value=v.value);

INSERT INTO timesheets(employee_id,location_id,work_date,clock_in,clock_out,break_minutes,regular_minutes,overtime_minutes,status,note,approved_by,approved_at)
SELECT e.id,e.location_id,d::date,d::date+TIME '08:00',d::date+TIME '16:30',30,480,CASE WHEN EXTRACT(ISODOW FROM d)=6 THEN 60 ELSE 0 END,'approved','DEMO jelenléti adat','demo-admin',now()
FROM employees e CROSS JOIN generate_series(CURRENT_DATE-INTERVAL '24 days',CURRENT_DATE-INTERVAL '1 day',INTERVAL '1 day')d
WHERE e.email LIKE 'demo.%@kleoszalon.hu' AND EXTRACT(ISODOW FROM d) BETWEEN 1 AND 6
ON CONFLICT(employee_id,work_date) DO NOTHING;

INSERT INTO leave_requests(employee_id,leave_type_id,date_from,date_to,minutes_per_day,reason,status,approved_by,approved_at)
SELECT e.id,t.id,v.date_from,v.date_to,480,v.reason,v.status,CASE WHEN v.status IN('approved','rejected') THEN 'demo-admin' END,CASE WHEN v.status IN('approved','rejected') THEN now() END
FROM (VALUES
 ('demo.julia.szabo@kleoszalon.hu','annual',CURRENT_DATE+7,CURRENT_DATE+9,'Előre tervezett éves szabadság','pending'),
 ('demo.brigitta.varga@kleoszalon.hu','sick',CURRENT_DATE-14,CURRENT_DATE-12,'Orvosi igazolással lezárt távollét','approved'),
 ('demo.maria.fekete@kleoszalon.hu','other',CURRENT_DATE+3,CURRENT_DATE+3,'Tanulmányi elfoglaltság','approved'),
 ('demo.leila.horvath@kleoszalon.hu','unpaid',CURRENT_DATE+14,CURRENT_DATE+15,'Családi ügyintézés','pending')
)v(email,type_code,date_from,date_to,reason,status)
JOIN employees e ON lower(e.email)=lower(v.email) JOIN leave_types t ON t.code=v.type_code
WHERE NOT EXISTS(SELECT 1 FROM leave_requests r WHERE r.employee_id=e.id AND r.leave_type_id=t.id AND r.date_from=v.date_from);

INSERT INTO payroll_settings(location_id,name,currency,standard_daily_minutes,standard_monthly_hours,include_draft_timesheets,include_unpaid_workorders,pay_paid_leave,calculate_service_commission,calculate_product_commission,calculate_revenue_commission,calculate_overtime,calculate_weekend_extra,calculate_evening_extra,calculate_attendance_bonus,calculate_target_bonus,tax_percent,social_contribution_percent,default_deduction,custom_settings,is_active)
SELECT l.id,'DEMO – Kleoszalon Eger alapbeállítás','HUF',480,174,false,false,true,true,true,true,true,true,true,true,true,15,18.5,0,'{"seed":"20260805_KLEO_DEMO_DATA","note":"tesztértékek, nem hivatalos bérszámfejtés"}'::jsonb,true
FROM locations l WHERE lower(l.email)='demo.eger@kleoszalon.hu'
AND NOT EXISTS(SELECT 1 FROM payroll_settings s WHERE s.location_id=l.id AND s.name='DEMO – Kleoszalon Eger alapbeállítás' AND s.is_active);

INSERT INTO payroll_runs(location_id,period_from,period_to,title,status,settings_snapshot,gross_total,deduction_total,net_total,created_by,approved_by,approved_at)
SELECT s.location_id,date_trunc('month',CURRENT_DATE-INTERVAL '1 month')::date,(date_trunc('month',CURRENT_DATE)-INTERVAL '1 day')::date,'DEMO – Eger előző havi számfejtés','approved',to_jsonb(s),0,0,0,'demo-admin','demo-admin',now()
FROM payroll_settings s WHERE s.name='DEMO – Kleoszalon Eger alapbeállítás' AND s.is_active
AND NOT EXISTS(SELECT 1 FROM payroll_runs WHERE title='DEMO – Eger előző havi számfejtés');

INSERT INTO payroll_items(payroll_run_id,employee_id,compensation_plan_id,regular_minutes,overtime_minutes,worked_days,shifts,service_revenue,product_revenue,total_revenue,base_pay,overtime_pay,weekend_pay,evening_pay,service_commission,product_commission,revenue_commission,attendance_bonus,target_bonus,manual_adjustment,deductions,gross_pay,net_pay,calculation_details,note)
SELECT r.id,e.id,a.compensation_plan_id,9600,120,20,20,900000+(row_number() OVER())*75000,120000+(row_number() OVER())*10000,1020000+(row_number() OVER())*85000,COALESCE(a.monthly_base,p.monthly_base,e.monthly_wage,0),COALESCE(a.hourly_rate,p.hourly_rate,e.hourly_wage,0)*3,12000,8000,(900000+(row_number() OVER())*75000)*COALESCE(a.service_commission_percent,p.service_commission_percent,e.commission_percent,0)/100,(120000+(row_number() OVER())*10000)*COALESCE(a.product_commission_percent,p.product_commission_percent,0)/100,0,COALESCE(p.attendance_bonus,0),0,0,0,COALESCE(a.monthly_base,p.monthly_base,e.monthly_wage,0)+50000,COALESCE(a.monthly_base,p.monthly_base,e.monthly_wage,0)+50000,'{"source":"DEMO seed","calculation":"illustrative"}'::jsonb,'DEMO számfejtési sor – teszteléshez'
FROM payroll_runs r CROSS JOIN employees e LEFT JOIN employee_compensation_assignments a ON a.employee_id=e.id AND a.is_active LEFT JOIN compensation_plans p ON p.id=a.compensation_plan_id
WHERE r.title='DEMO – Eger előző havi számfejtés' AND e.email LIKE 'demo.%@kleoszalon.hu' AND e.location_id=r.location_id
ON CONFLICT(payroll_run_id,employee_id) DO NOTHING;

UPDATE payroll_runs r SET gross_total=x.gross,deduction_total=x.deductions,net_total=x.net,updated_at=now()
FROM(SELECT payroll_run_id,SUM(gross_pay)gross,SUM(deductions)deductions,SUM(net_pay)net FROM payroll_items GROUP BY payroll_run_id)x
WHERE r.id=x.payroll_run_id AND r.title='DEMO – Eger előző havi számfejtés';

INSERT INTO audit_log(actor_user_id,actor_role,action,entity_type,entity_id,location_id,new_data,request_id,created_at)
SELECT 'demo-admin','admin','seed','demo_dataset','20260805_KLEO_DEMO_DATA',NULL,'{"source":"kleoszalon.hu","purpose":"életszerű HR és bérszámfejtési tesztadatok"}'::jsonb,'demo-seed-20260805',now()
WHERE NOT EXISTS(SELECT 1 FROM audit_log WHERE entity_id='20260805_KLEO_DEMO_DATA');

INSERT INTO schema_migrations(version,description) VALUES('20260805_KLEO_DEMO_DATA','Kleoszalon életszerű DEMO HR, jelenlét, szabadság, bér és jogosultsági tesztadatok') ON CONFLICT(version) DO NOTHING;
COMMIT;
