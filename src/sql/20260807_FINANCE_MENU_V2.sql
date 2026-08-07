BEGIN;

ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS menus_code_uq ON menus(code);

INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES('finance','Pénzügyek','WalletCards',NULL,60,NULL,'finance',true)
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,icon=EXCLUDED.icon,route=NULL,order_index=60,feature_key='finance',is_active=true;

WITH p AS (SELECT id FROM menus WHERE code='finance' LIMIT 1),
items(code,name,route,order_index,feature_key) AS (
 VALUES
 ('finance.dashboard','Pénzügyi dashboard','/finance',10,'finance'),
 ('finance.checkout','Pénztár és fizetés','/finance',20,'pos_checkout'),
 ('finance.transactions','Pénzügyi műveletek','/finance/transactions',30,'transactions'),
 ('finance.cash','Számlák és pénztárak','/finance/cash',40,'cash_management'),
 ('finance.invoices.out','Kimenő számlák','/finance/invoices/out',50,'invoicing'),
 ('finance.invoices.in','Bejövő számlák','/finance/invoices/in',60,'invoicing'),
 ('finance.partners','Partnerek','/masterdata/partners',70,'partners'),
 ('finance.payroll','Bérszámfejtés','/modules/team/payroll?tab=payroll',80,'payroll'),
 ('finance.payslips','Bérjegyzékek és kiküldés','/modules/team/payroll?tab=payslips',90,'payroll'),
 ('finance.accounting','Könyvelés és főkönyv','/modules/team/payroll?tab=accounting',100,'accounting'),
 ('finance.tax','Adók és járulékok','/modules/team/payroll?tab=legal',110,'payroll'),
 ('finance.online','Online fizetés','/modules/finance/online-payments',120,'online_payments'),
 ('finance.reports','Pénzügyi jelentések','/reports/top-metrics',130,'finance_analytics'),
 ('finance.settings','Pénzügyi beállítások','/modules/team/payroll?tab=legal',140,'finance')
)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT i.code,i.name,NULL,i.route,i.order_index,p.id,i.feature_key,true FROM items i CROSS JOIN p
ON CONFLICT(code) DO UPDATE SET name=EXCLUDED.name,route=EXCLUDED.route,order_index=EXCLUDED.order_index,parent_id=EXCLUDED.parent_id,feature_key=EXCLUDED.feature_key,is_active=true;

-- Régi, párhuzamos pénzügyi menüpontok kikapcsolása, ha vannak.
UPDATE menus SET is_active=false
WHERE code IN ('finance.accounts','finance.invoices')
  AND code NOT IN ('finance.accounting');

-- Admin teljes hozzáférés az új Pénzügyek menühöz.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'admin',m.id,true,true,true,true,true,true,true,true,'all_locations',now()
FROM menus m WHERE m.code='finance' OR m.code LIKE 'finance.%'
ON CONFLICT(role_key,menu_id) DO UPDATE SET can_view=true,can_create=true,can_edit=true,can_delete=true,can_approve=true,can_export=true,can_view_financial=true,can_manage_permissions=true,scope_type='all_locations',updated_at=now();

-- Vezető: pénzügyi olvasás/kezelés/jóváhagyás, jogosultság-admin és törlés nélkül.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'manager',m.id,true,true,true,false,true,true,true,false,'all_locations',now()
FROM menus m WHERE m.code='finance' OR m.code LIKE 'finance.%'
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- Recepció: operatív kassza és tranzakciók, bér/könyvelés nélkül.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'receptionist',m.id,
 CASE WHEN m.code IN ('finance','finance.dashboard','finance.checkout','finance.transactions','finance.cash','finance.online') THEN true ELSE false END,
 CASE WHEN m.code IN ('finance.checkout','finance.transactions','finance.cash') THEN true ELSE false END,
 CASE WHEN m.code IN ('finance.checkout','finance.transactions','finance.cash') THEN true ELSE false END,
 false,false,
 CASE WHEN m.code IN ('finance.transactions','finance.cash') THEN true ELSE false END,
 CASE WHEN m.code IN ('finance.checkout','finance.transactions','finance.cash') THEN true ELSE false END,
 false,'own_location',now()
FROM menus m WHERE m.code='finance' OR m.code LIKE 'finance.%'
ON CONFLICT(role_key,menu_id) DO NOTHING;

-- Munkatárs: pénzügyi főmenü rejtve; saját bérjegyzék külön dolgozói felületen lesz elérhető.
INSERT INTO role_menu_permissions(role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,can_view_financial,can_manage_permissions,scope_type,updated_at)
SELECT 'employee',m.id,false,false,false,false,false,false,false,false,'own',now()
FROM menus m WHERE m.code='finance' OR m.code LIKE 'finance.%'
ON CONFLICT(role_key,menu_id) DO NOTHING;

INSERT INTO role_feature_permissions(role_key,feature_key,can_use,scope_type,updated_at)
VALUES
 ('admin','finance',true,'all_locations',now()),('admin','payroll',true,'all_locations',now()),('admin','accounting',true,'all_locations',now()),
 ('manager','finance',true,'all_locations',now()),('manager','payroll',true,'all_locations',now()),('manager','accounting',true,'all_locations',now()),
 ('receptionist','finance',true,'own_location',now()),('receptionist','payroll',false,'own_location',now()),('receptionist','accounting',false,'own_location',now()),
 ('employee','finance',false,'own',now()),('employee','payroll',false,'own',now()),('employee','accounting',false,'own',now())
ON CONFLICT(role_key,feature_key) DO UPDATE SET can_use=EXCLUDED.can_use,scope_type=EXCLUDED.scope_type,updated_at=now();

COMMIT;

SELECT m.code,m.name,m.route,m.order_index,m.feature_key,m.is_active
FROM menus m
WHERE m.code='finance' OR m.code LIKE 'finance.%'
ORDER BY m.order_index,m.code;
