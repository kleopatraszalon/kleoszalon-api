-- Reversible VIR demo dataset for production/UAT visual and functional testing.
-- All owned rows are isolated by dedicated TEST locations and/or VIR-DEMO-20260821 markers.
-- Cleanup entry point: npm run demo:cleanup:vir

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS vir_demo_batches (
  batch_key text PRIMARY KEY,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO vir_demo_batches(batch_key,description)
VALUES('VIR-DEMO-20260821','Reversible VIR test dataset: CRM, employees, appointments, HR, loyalty, stock and daily actions')
ON CONFLICT(batch_key) DO NOTHING;

DO $$
DECLARE
  demo_tenant_id bigint;
  role_type text;
BEGIN
  SELECT id INTO demo_tenant_id FROM tenants WHERE slug='kleopatra' LIMIT 1;
  IF demo_tenant_id IS NULL THEN
    RAISE NOTICE 'VIR demo seed skipped: tenant kleopatra not found';
    RETURN;
  END IF;

  IF to_regclass('public.locations') IS NULL THEN
    RAISE NOTICE 'VIR demo seed skipped: locations table missing';
    RETURN;
  END IF;

  INSERT INTO locations(name,address,city,phone,email,is_active,tenant_id)
  SELECT v.name,v.address,v.city,v.phone,v.email,true,demo_tenant_id
  FROM (VALUES
    ('TESZT – VIR Eger','Teszt tér 1.','Eger','+36 30 900 8101','vir.demo.eger@example.invalid'),
    ('TESZT – VIR Salgótarján','Teszt tér 2.','Salgótarján','+36 30 900 8102','vir.demo.salgotarjan@example.invalid'),
    ('TESZT – VIR Budapest','Teszt tér 3.','Budapest','+36 30 900 8103','vir.demo.budapest@example.invalid')
  ) v(name,address,city,phone,email)
  WHERE NOT EXISTS (SELECT 1 FROM locations l WHERE lower(l.email)=lower(v.email));

  IF to_regclass('public.employees') IS NOT NULL THEN
    INSERT INTO employees(full_name,email,phone,qualification,location_id,active,tenant_id)
    SELECT v.full_name,v.email,v.phone,v.qualification,l.id,true,demo_tenant_id
    FROM (VALUES
      ('TESZT Kovács Anna','vir.demo.anna.eger@example.invalid','+36 30 901 1001','Mesterfodrász','vir.demo.eger@example.invalid'),
      ('TESZT Nagy Eszter','vir.demo.eszter.eger@example.invalid','+36 30 901 1002','Kozmetikus','vir.demo.eger@example.invalid'),
      ('TESZT Szabó Júlia','vir.demo.julia.eger@example.invalid','+36 30 901 1003','Kéz- és lábápoló','vir.demo.eger@example.invalid'),
      ('TESZT Tóth Petra','vir.demo.petra.eger@example.invalid','+36 30 901 1004','Recepciós','vir.demo.eger@example.invalid'),
      ('TESZT Kiss Kamilla','vir.demo.kamilla.salgotarjan@example.invalid','+36 30 902 1001','Fodrász','vir.demo.salgotarjan@example.invalid'),
      ('TESZT Varga Brigitta','vir.demo.brigitta.salgotarjan@example.invalid','+36 30 902 1002','Kozmetikus','vir.demo.salgotarjan@example.invalid'),
      ('TESZT Farkas Dorottya','vir.demo.dorottya.salgotarjan@example.invalid','+36 30 902 1003','Masszőr','vir.demo.salgotarjan@example.invalid'),
      ('TESZT Molnár Réka','vir.demo.reka.salgotarjan@example.invalid','+36 30 902 1004','Recepciós','vir.demo.salgotarjan@example.invalid'),
      ('TESZT Balogh László','vir.demo.laszlo.budapest@example.invalid','+36 30 903 1001','Borbély','vir.demo.budapest@example.invalid'),
      ('TESZT Pál Gábor','vir.demo.gabor.budapest@example.invalid','+36 30 903 1002','Fodrász','vir.demo.budapest@example.invalid'),
      ('TESZT Fekete Mária','vir.demo.maria.budapest@example.invalid','+36 30 903 1003','Masszőr','vir.demo.budapest@example.invalid'),
      ('TESZT Horváth Leila','vir.demo.leila.budapest@example.invalid','+36 30 903 1004','Recepciós','vir.demo.budapest@example.invalid')
    ) v(full_name,email,phone,qualification,location_email)
    JOIN locations l ON lower(l.email)=lower(v.location_email)
    WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE lower(e.email)=lower(v.email));

    SELECT udt_name INTO role_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='employees' AND column_name='role' LIMIT 1;
    IF role_type='jsonb' THEN
      UPDATE employees SET role='["employee"]'::jsonb
       WHERE email LIKE 'vir.demo.%@example.invalid' AND (role IS NULL OR role::text IN ('','[]','null'));
    ELSIF role_type IS NOT NULL THEN
      UPDATE employees SET role='employee'
       WHERE email LIKE 'vir.demo.%@example.invalid' AND COALESCE(role::text,'')='';
    END IF;
  END IF;

  IF to_regclass('public.clients') IS NOT NULL THEN
    INSERT INTO clients(
      full_name,name,phone,email,location_id,birth_date,gender,city,address,notes,
      preferred_contact,marketing_consent,email_consent,sms_consent,phone_consent,
      consent_source,privacy_notice_version,consent_recorded_at,is_active,source,
      altegio_spent,altegio_paid,altegio_visits,altegio_first_visit,altegio_last_visit,altegio_discount,
      tenant_id,updated_at
    )
    SELECT
      'TESZT Vendég '||lpad(gs::text,2,'0')||' – '||replace(l.name,'TESZT – VIR ',''),
      'TESZT Vendég '||lpad(gs::text,2,'0')||' – '||replace(l.name,'TESZT – VIR ',''),
      '+36 30 91'||right('00'||gs::text,2)||right(replace(l.id::text,'-',''),2),
      'vir.demo.client.'||replace(l.id::text,'-','')||'.'||gs||'@example.invalid',
      l.id,
      (DATE '1978-01-01' + ((gs*431) % 9000))::date,
      CASE WHEN gs%3=0 THEN 'male' ELSE 'female' END,
      l.city,
      'Teszt utca '||gs||'.',
      '[VIR-DEMO-20260821] Kizárólag rendszer- és UI-tesztelésre szolgáló fiktív vendég.',
      CASE WHEN gs%2=0 THEN 'email' ELSE 'phone' END,
      true,true,(gs%2=0),true,
      'vir-demo','VIR-DEMO-20260821',now(),true,'vir-demo-20260821',
      (gs*28000 + (gs%5)*15000)::numeric,
      (gs*25000 + (gs%4)*12000)::numeric,
      2 + gs,
      now() - ((180-gs*3)||' days')::interval,
      now() - ((gs+2)||' days')::interval,
      CASE WHEN gs>=12 THEN 10 WHEN gs>=7 THEN 5 ELSE 0 END,
      demo_tenant_id,now()
    FROM locations l CROSS JOIN generate_series(1,15) gs
    WHERE l.email LIKE 'vir.demo.%@example.invalid'
      AND NOT EXISTS (
        SELECT 1 FROM clients c
         WHERE lower(c.email)=lower('vir.demo.client.'||replace(l.id::text,'-','')||'.'||gs||'@example.invalid')
      );
  END IF;

  IF to_regclass('public.crm_tags') IS NOT NULL THEN
    INSERT INTO crm_tags(name,color,is_active,tenant_id)
    SELECT 'VIR TESZT','#7c5ce5',true,demo_tenant_id
    WHERE NOT EXISTS(SELECT 1 FROM crm_tags WHERE lower(name)=lower('VIR TESZT'));
  END IF;

  IF to_regclass('public.crm_client_tags') IS NOT NULL AND to_regclass('public.crm_tags') IS NOT NULL THEN
    INSERT INTO crm_client_tags(client_id,tag_id,tenant_id)
    SELECT c.id,t.id,demo_tenant_id
      FROM clients c JOIN crm_tags t ON lower(t.name)=lower('VIR TESZT')
     WHERE c.source='vir-demo-20260821'
    ON CONFLICT DO NOTHING;
  END IF;

  IF to_regclass('public.crm_client_notes') IS NOT NULL THEN
    INSERT INTO crm_client_notes(client_id,note_text,created_by,tenant_id)
    SELECT c.id,'[VIR-DEMO-20260821] Próba CRM-megjegyzés: visszahívás és kezelési preferencia.','vir-demo-seed',demo_tenant_id
      FROM clients c
     WHERE c.source='vir-demo-20260821'
       AND NOT EXISTS(SELECT 1 FROM crm_client_notes n WHERE n.client_id=c.id AND n.note_text LIKE '[VIR-DEMO-20260821]%');
  END IF;

  IF to_regclass('public.appointments') IS NOT NULL AND to_regclass('public.employees') IS NOT NULL THEN
    INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,tenant_id)
    SELECT
      e.id,c.id,c.location_id,
      COALESCE(s.name,'TESZT szolgáltatás'),
      ((CURRENT_DATE + v.day_offset) + make_time(v.hour_value,0,0)) AT TIME ZONE 'Europe/Budapest',
      (((CURRENT_DATE + v.day_offset) + make_time(v.hour_value,0,0)) AT TIME ZONE 'Europe/Budapest') + (COALESCE(s.duration_minutes,45)::int||' minutes')::interval,
      CASE WHEN v.day_offset<0 THEN CASE WHEN (abs(v.day_offset)+v.slot_no)%9=0 THEN 'no_show' WHEN (abs(v.day_offset)+v.slot_no)%11=0 THEN 'cancelled' ELSE 'completed' END ELSE 'confirmed' END,
      'VIR-DEMO-20260821:'||c.id::text||':'||v.slot_no,
      demo_tenant_id
    FROM clients c
    JOIN LATERAL (
      SELECT e1.* FROM employees e1
       WHERE e1.location_id::text=c.location_id::text AND e1.email LIKE 'vir.demo.%@example.invalid'
       ORDER BY md5(e1.id::text||c.id::text) LIMIT 1
    ) e ON true
    LEFT JOIN LATERAL (
      SELECT s1.id,s1.name,COALESCE(s1.duration_minutes,45)::int duration_minutes
        FROM services s1 WHERE COALESCE(s1.is_active,true)=true
       ORDER BY md5(s1.id::text||c.id::text) LIMIT 1
    ) s ON true
    CROSS JOIN (VALUES (-21,10,1),(-7,14,2),(7,11,3),(21,16,4)) v(day_offset,hour_value,slot_no)
    WHERE c.source='vir-demo-20260821'
      AND NOT EXISTS(SELECT 1 FROM appointments a WHERE a.notes='VIR-DEMO-20260821:'||c.id::text||':'||v.slot_no);
  END IF;

  IF to_regclass('public.appointment_services') IS NOT NULL AND to_regclass('public.services') IS NOT NULL THEN
    INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order,tenant_id)
    SELECT a.id,s.id,COALESCE(s.duration_minutes,45)::int,
           COALESCE(s.promo_price,s.list_price,s.base_price,0)::numeric,0,0,demo_tenant_id
      FROM appointments a
      JOIN LATERAL (
        SELECT s1.* FROM services s1 WHERE COALESCE(s1.is_active,true)=true
         ORDER BY md5(s1.id::text||a.id::text) LIMIT 1
      ) s ON true
     WHERE a.notes LIKE 'VIR-DEMO-20260821:%'
       AND NOT EXISTS(SELECT 1 FROM appointment_services x WHERE x.appointment_id=a.id);
  END IF;

  IF to_regclass('public.loyalty_program_members') IS NOT NULL THEN
    INSERT INTO loyalty_program_members(client_id,tier_code,booked_total,paid_total,visit_count,last_visit_at,evaluated_at)
    SELECT c.id,
           CASE WHEN COALESCE(c.altegio_paid,0)>=300000 THEN 'gold' WHEN COALESCE(c.altegio_paid,0)>=150000 THEN 'silver' ELSE 'bronze' END,
           COALESCE(c.altegio_spent,0),COALESCE(c.altegio_paid,0),COALESCE(c.altegio_visits,0),c.altegio_last_visit,now()
      FROM clients c WHERE c.source='vir-demo-20260821'
    ON CONFLICT(client_id) DO UPDATE SET
      tier_code=EXCLUDED.tier_code,booked_total=EXCLUDED.booked_total,paid_total=EXCLUDED.paid_total,
      visit_count=EXCLUDED.visit_count,last_visit_at=EXCLUDED.last_visit_at,evaluated_at=now();
  END IF;

  IF to_regclass('public.timesheets') IS NOT NULL THEN
    INSERT INTO timesheets(employee_id,location_id,work_date,clock_in,clock_out,break_minutes,regular_minutes,overtime_minutes,status,note,approved_by,approved_at,tenant_id)
    SELECT e.id,e.location_id,d::date,d::date+TIME '08:00',d::date+TIME '16:30',30,480,
           CASE WHEN EXTRACT(ISODOW FROM d)=6 THEN 60 ELSE 0 END,'approved','VIR-DEMO-20260821','vir-demo-admin',now(),demo_tenant_id
      FROM employees e
      CROSS JOIN generate_series(CURRENT_DATE-INTERVAL '14 days',CURRENT_DATE-INTERVAL '1 day',INTERVAL '1 day') d
     WHERE e.email LIKE 'vir.demo.%@example.invalid' AND EXTRACT(ISODOW FROM d) BETWEEN 1 AND 6
    ON CONFLICT(employee_id,work_date) DO NOTHING;
  END IF;

  IF to_regclass('public.leave_requests') IS NOT NULL AND to_regclass('public.leave_types') IS NOT NULL THEN
    INSERT INTO leave_requests(employee_id,leave_type_id,date_from,date_to,minutes_per_day,reason,status,approved_by,approved_at,tenant_id)
    SELECT e.id,lt.id,CURRENT_DATE+5,CURRENT_DATE+7,480,'[VIR-DEMO-20260821] Tervezett teszt szabadság','pending',NULL,NULL,demo_tenant_id
      FROM employees e
      JOIN LATERAL (SELECT id FROM leave_types ORDER BY code LIMIT 1) lt ON true
     WHERE e.email IN ('vir.demo.anna.eger@example.invalid','vir.demo.kamilla.salgotarjan@example.invalid','vir.demo.laszlo.budapest@example.invalid')
       AND NOT EXISTS(SELECT 1 FROM leave_requests lr WHERE lr.employee_id=e.id AND lr.reason LIKE '[VIR-DEMO-20260821]%');
  END IF;

  IF to_regclass('public.product_stock_balances') IS NOT NULL AND to_regclass('public.products') IS NOT NULL THEN
    INSERT INTO product_stock_balances(product_id,location_id,quantity,min_quantity,unit_cost,tenant_id,updated_at)
    SELECT p.id,l.id,10+(row_number() OVER(PARTITION BY l.id ORDER BY p.name)%15),5,COALESCE(NULLIF(p.purchase_price,0),0),demo_tenant_id,now()
      FROM locations l CROSS JOIN LATERAL (
        SELECT p1.* FROM products p1 WHERE COALESCE(p1.is_active,true)=true ORDER BY p1.name LIMIT 12
      ) p
     WHERE l.email LIKE 'vir.demo.%@example.invalid'
       AND NOT EXISTS(SELECT 1 FROM product_stock_balances b WHERE b.product_id=p.id AND b.location_id=l.id);
  END IF;

  IF to_regclass('public.inventory_movements') IS NOT NULL AND to_regclass('public.product_stock_balances') IS NOT NULL THEN
    INSERT INTO inventory_movements(product_id,location_id,movement_type,quantity,balance_after,unit_cost,stock_value_after,note,created_by,tenant_id)
    SELECT b.product_id,b.location_id,'opening',b.quantity,b.quantity,COALESCE(b.unit_cost,0),b.quantity*COALESCE(b.unit_cost,0),'VIR-DEMO-20260821','vir-demo-seed',demo_tenant_id
      FROM product_stock_balances b JOIN locations l ON l.id=b.location_id
     WHERE l.email LIKE 'vir.demo.%@example.invalid'
       AND NOT EXISTS(SELECT 1 FROM inventory_movements m WHERE m.product_id=b.product_id AND m.location_id=b.location_id AND m.note='VIR-DEMO-20260821');
  END IF;

  IF to_regclass('public.salon_stock_requests') IS NOT NULL AND to_regclass('public.products') IS NOT NULL THEN
    INSERT INTO salon_stock_requests(location_id,product_id,requested_quantity,status,source,note,created_by)
    SELECT l.id,p.id,5+(row_number() OVER(PARTITION BY l.id ORDER BY p.name)%8),'requested','demo','VIR-DEMO-20260821','vir-demo-seed'
      FROM locations l CROSS JOIN LATERAL (
        SELECT p1.id,p1.name FROM products p1 WHERE COALESCE(p1.is_active,true)=true ORDER BY p1.name LIMIT 3
      ) p
     WHERE l.email LIKE 'vir.demo.%@example.invalid'
       AND NOT EXISTS(SELECT 1 FROM salon_stock_requests r WHERE r.location_id=l.id AND r.product_id=p.id AND r.note='VIR-DEMO-20260821');
  END IF;

  IF to_regclass('public.daily_action_campaigns') IS NOT NULL THEN
    INSERT INTO daily_action_campaigns(name,headline,description_html,discount_text,valid_from,valid_until,audience,channels,status)
    SELECT v.name,v.headline,v.description_html,v.discount_text,v.valid_from,v.valid_until,v.audience::jsonb,v.channels::jsonb,v.status
    FROM (VALUES
      ('VIR DEMO – Hétfői szépségnap','TESZT: -20% kiválasztott kezelésekre','<p><strong>VIR tesztkampány.</strong> A tartalom nem valós ajánlat.</p>','-20%',now()-interval '1 day',now()+interval '6 days','{"type":"all"}','["app"]','draft'),
      ('VIR DEMO – Törzsvendég ajánlat','TESZT: VIP vendégajánlat','<p>Fiktív hűségkampány a célcsoport és előnézet tesztelésére.</p>','VIP 15%',now(),now()+interval '10 days','{"type":"loyalty","tiers":["gold","silver"]}','["email","app"]','draft'),
      ('VIR DEMO – Új vendég kupon','TESZT: első látogatás kedvezmény','<p>Fiktív új vendég kampány.</p>','-10%',now(),now()+interval '14 days','{"type":"new","days":30}','["sms","app"]','draft')
    ) v(name,headline,description_html,discount_text,valid_from,valid_until,audience,channels,status)
    WHERE NOT EXISTS(SELECT 1 FROM daily_action_campaigns d WHERE d.name=v.name);
  END IF;

  RAISE NOTICE 'VIR-DEMO-20260821 seed complete';
END $$;
