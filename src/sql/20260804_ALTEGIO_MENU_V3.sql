-- ALTEGIO-KOMPATIBILIS, ADATBÁZIS-ALAPÚ MENÜMIGRÁCIÓ – V3
-- Futtassa a teljes fájlt az első sortól az utolsóig.
BEGIN;

ALTER TABLE menus ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS feature_key text;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE menus ADD COLUMN IF NOT EXISTS required_permission text;

-- A korábbi részleges index nem használható a sima ON CONFLICT (code) kifejezéshez.
-- A teljes UNIQUE index továbbra is több NULL értéket enged, viszont konfliktuscélként felismerhető.
DROP INDEX IF EXISTS menus_code_uq;
CREATE UNIQUE INDEX menus_code_uq ON menus(code);

-- A korábbi menük megmaradnak visszaállítási lehetőségként, de az új katalógus mellett nem jelennek meg.
UPDATE menus SET is_active = false WHERE code IS NULL;

INSERT INTO menus (code, name, icon, route, order_index, parent_id, feature_key, is_active)
VALUES
  ('dashboard', 'Vezérlőpult', 'LayoutDashboard', '/dashboard', 10, NULL, 'dashboard', true),
  ('appointments', 'Időpontok és jelenlét', 'CalendarDays', NULL, 20, NULL, 'appointments', true),
  ('customers', 'Ügyfelek és CRM', 'Users', NULL, 30, NULL, 'crm', true),
  ('loyalty', 'Hűség, bérletek és ajándékkártyák', 'Gift', NULL, 40, NULL, 'loyalty', true),
  ('team', 'Csapat és HR', 'UserCog', NULL, 50, NULL, 'team', true),
  ('finance', 'Pénzügy és pénztár', 'WalletCards', NULL, 60, NULL, 'finance', true),
  ('inventory', 'Raktár és készlet', 'Boxes', NULL, 70, NULL, 'inventory', true),
  ('analytics', 'Statisztika és VIR', 'ChartNoAxesCombined', NULL, 80, NULL, 'analytics', true),
  ('locations', 'Szalonhálózat', 'Building2', NULL, 90, NULL, 'multi_location', true),
  ('marketing', 'Kommunikáció és marketing', 'Megaphone', NULL, 100, NULL, 'marketing', true),
  ('online', 'Online foglalás és ügyfélalkalmazás', 'Globe2', NULL, 110, NULL, 'online_booking', true),
  ('commerce', 'Webshop és értékesítés', 'ShoppingBag', NULL, 120, NULL, 'commerce', true),
  ('screens', 'Kijelzők és kioszk', 'MonitorSmartphone', NULL, 130, NULL, 'screens', true),
  ('integrations', 'Integrációk és API', 'PlugZap', NULL, 140, NULL, 'integrations', true),
  ('settings', 'Beállítások és adminisztráció', 'Settings', NULL, 150, NULL, 'settings', true)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, icon = EXCLUDED.icon, route = EXCLUDED.route,
  order_index = EXCLUDED.order_index,
  feature_key = EXCLUDED.feature_key, is_active = true;

WITH items(code, parent_code, name, route, order_index, feature_key) AS (
  VALUES
    ('appointments.calendar','appointments','Naptár és digitális beosztás','/appointments/calendar',10,'digital_schedule'),
    ('appointments.online','appointments','Online időpontfoglalás','/modules/appointments/online-booking',20,'online_booking'),
    ('appointments.list','appointments','Időpontok listája','/modules/appointments/list',30,'appointments'),
    ('appointments.complex','appointments','Komplex szolgáltatások (4+ kéz)','/modules/appointments/complex-services',40,'complex_services'),
    ('appointments.groups','appointments','Csoportos foglalások és események','/modules/appointments/group-bookings',50,'group_bookings'),
    ('appointments.notifications','appointments','Foglalási értesítések','/modules/appointments/notifications',60,'notifications'),
    ('appointments.attendance','appointments','Lemondások és meg nem jelenések','/modules/appointments/attendance',70,'attendance'),

    ('customers.list','customers','Ügyféltörzs','/modules/customers/list',10,'crm'),
    ('customers.profile','customers','Ügyféladatlapok és előzmények','/modules/customers/profiles',20,'client_records'),
    ('customers.forms','customers','Kérdőívek és nyilatkozatok','/modules/customers/forms',30,'client_forms'),
    ('customers.segments','customers','Címkék és ügyfélszegmensek','/modules/customers/segments',40,'crm_segments'),
    ('customers.import','customers','Importálás és duplikációkezelés','/modules/customers/import',50,'crm_import'),
    ('customers.loyalty_program','customers','Törzsvásárlói program','/modules/customers/loyalty-program',60,'loyalty'),

    ('loyalty.program','loyalty','Hűségprogram','/modules/loyalty/program',10,'loyalty_program'),
    ('loyalty.memberships','loyalty','Bérletek és tagságok','/modules/loyalty/memberships',20,'memberships'),
    ('loyalty.giftcards','loyalty','Ajándékkártyák','/modules/loyalty/gift-cards',30,'gift_cards'),
    ('loyalty.discounts','loyalty','Kedvezmények és promóciós kódok','/modules/loyalty/discounts',40,'discounts'),
    ('loyalty.balances','loyalty','Ügyfélegyenlegek','/modules/loyalty/balances',50,'client_balances'),

    ('team.employees','team','Munkatársak','/employees',10,'staff'),
    ('team.schedule','team','Munkaidő és beosztás','/timetable/update',20,'staff_schedule'),
    ('team.positions','team','Munkakörök','/hr/positions',30,'hr'),
    ('team.vacations','team','Szabadságok és távollétek','/hr/vacations',30,'staff_absence'),
    ('team.performance','team','Teljesítmény és értékelés','/modules/team/performance',50,'staff_performance'),
    ('team.roles','team','Szerepkörök és jogosultságok','/modules/team/roles',60,'roles_access'),

    ('finance.checkout','finance','Pénztár és fizetés','/modules/finance/checkout',10,'pos_checkout'),
    ('finance.transactions','finance','Bevételek és kiadások','/finance/transactions',20,'transactions'),
    ('finance.cash','finance','Kasszák és műszakzárás','/finance/cash',30,'cash_management'),
    ('finance.invoices','finance','Számlák és bizonylatok','/finance/invoice',40,'invoicing'),
    ('finance.online','finance','Online fizetések','/modules/finance/online-payments',50,'online_payments'),
    ('finance.accounts','finance','Pénzügyi számlák és költséghelyek','/modules/finance/accounts',60,'accounting'),
    ('finance.workorders','finance','Munkalapok','/workorders/list',70,'workorders'),
    ('finance.payroll','finance','Bér- és jutalékszámítás','/modules/team/payroll',80,'payroll'),

    ('inventory.products','inventory','Termékek','/products',10,'products'),
    ('inventory.stock','inventory','Aktuális készlet','/warehouse/list',20,'stock'),
    ('inventory.receiving','inventory','Bevételezés és beszerzés','/warehouse/incoming',30,'purchasing'),
    ('inventory.transfers','inventory','Raktárközi mozgás','/inventory/transfer',40,'stock_transfer'),
    ('inventory.usage','inventory','Anyagfelhasználás','/inventory/usage',50,'consumption'),
    ('inventory.adjustment','inventory','Leltár és készletkorrekció','/inventory/adjustment',60,'stocktaking'),
    ('inventory.suppliers','inventory','Beszállítók','/masterdata/partners',70,'suppliers'),

    ('analytics.main','analytics','Legfőbb mutatók','/reports/top-metrics',10,'top_metrics'),
    ('analytics.vir','analytics','VIR Dashboard','/admin/vir',20,'vir_dashboard'),
    ('analytics.revenue','analytics','Bevétel és eredmény','/modules/analytics/revenue',30,'finance_analytics'),
    ('analytics.appointments','analytics','Foglalási statisztikák','/reports/appointments',40,'appointment_analytics'),
    ('analytics.clients','analytics','Ügyfélstatisztikák','/modules/analytics/clients',50,'client_analytics'),
    ('analytics.staff','analytics','Munkatársi teljesítmény','/modules/analytics/staff',60,'staff_analytics'),
    ('analytics.services','analytics','Szolgáltatási statisztikák','/modules/analytics/services',70,'service_analytics'),
    ('analytics.inventory','analytics','Készletstatisztikák','/modules/analytics/inventory',80,'inventory_analytics'),
    ('analytics.reports','analytics','Automatikus riportok','/admin/vir-reports',90,'scheduled_reports'),

    ('locations.salons','locations','Szalonok és telephelyek','/masters/salons',10,'locations'),
    ('locations.comparison','locations','Telephelyek összehasonlítása','/modules/locations/comparison',20,'chain_analytics'),
    ('locations.central','locations','Központi törzsadatkezelés','/modules/locations/central-data',30,'chain_management'),

    ('marketing.campaigns','marketing','Kampányok','/modules/marketing/campaigns',10,'campaigns'),
    ('marketing.notifications','marketing','SMS, e-mail, WhatsApp és push','/modules/marketing/notifications',20,'notifications'),
    ('marketing.templates','marketing','Üzenetsablonok','/modules/marketing/templates',30,'message_templates'),
    ('marketing.segments','marketing','Célcsoportok','/modules/marketing/segments',40,'marketing_segments'),
    ('marketing.feedback','marketing','Értékelések és visszajelzések','/modules/marketing/feedback',50,'feedback'),

    ('online.widget','online','Foglalási widget és linkek','/modules/online/booking-widget',10,'booking_widget'),
    ('online.channels','online','Weboldal és közösségi csatornák','/modules/online/channels',20,'booking_channels'),
    ('online.clientapp','online','Kleo ügyfélalkalmazás','/modules/online/client-app',30,'client_app'),
    ('online.staffapp','online','Munkatársi mobilalkalmazás','/modules/online/staff-app',40,'staff_app'),

    ('commerce.webshop','commerce','Webshop adminisztráció','/admin/webshop',10,'webshop'),
    ('commerce.orders','commerce','Rendelések','/modules/commerce/orders',20,'orders'),
    ('commerce.coupons','commerce','Webshop kuponok','/modules/commerce/coupons',30,'commerce_coupons'),

    ('screens.signage','screens','Digitális kijelzők','/admin/signage',10,'signage'),
    ('screens.kiosk','screens','Önkiszolgáló kioszk','/admin/kiosk',20,'kiosk'),

    ('integrations.marketplace','integrations','Integrációs piactér','/modules/integrations/marketplace',10,'integration_marketplace'),
    ('integrations.api','integrations','Nyílt API és webhookok','/modules/integrations/api',20,'open_api'),
    ('integrations.logs','integrations','Integrációs napló','/modules/integrations/logs',30,'integration_logs'),

    ('settings.services','settings','Szolgáltatások és árak','/masters/services',10,'services'),
    ('settings.categories','settings','Kategóriák és törzsadatok','/masters',20,'master_data'),
    ('settings.payment','settings','Fizetési módok','/masterdata/payment-methods',30,'payment_methods'),
    ('settings.customization','settings','Modulok és megjelenés testreszabása','/modules/settings/customization',40,'customization'),
    ('settings.audit','settings','Napló és adatbiztonság','/modules/settings/audit-log',50,'audit_log'),
    ('settings.system','settings','Rendszerbeállítások','/settings',60,'system_settings')
)
INSERT INTO menus (code, name, icon, route, order_index, parent_id, feature_key, is_active)
SELECT i.code, i.name, NULL, i.route, i.order_index, p.id, i.feature_key, true
FROM items i
JOIN menus p ON p.code = i.parent_code
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name, route = EXCLUDED.route, order_index = EXCLUDED.order_index,
  parent_id = EXCLUDED.parent_id,
  feature_key = EXCLUDED.feature_key, is_active = true;

COMMIT;
