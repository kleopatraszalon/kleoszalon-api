const fs=require('fs');
const assert=require('assert');

const route=fs.readFileSync('src/routes/systemSettings.ts','utf8');
const server=fs.readFileSync('src/server.ts','utf8');
const bootstrap=fs.readFileSync('src/virSpec/ensureVirSpecModules.ts','utf8');
const menu=fs.readFileSync('src/sql/20260813_SYSTEM_SETTINGS_CENTER_V1.sql','utf8');

for(const marker of [
  'booking.online_discount_percent',
  'equipment.service_warning_days',
  'finance.cash_variance_warning_huf',
  'supplier.shelf_life_warning_days',
  'router.get("/catalog"',
  'router.put("/:key"',
  'router.get("/alerts/summary"',
  'router.get("/audit/recent"',
  'system_settings_audit',
  'online_booking_settings',
]) assert(route.includes(marker),`missing settings marker: ${marker}`);

assert(server.includes('systemSettingsRouter from"./routes/systemSettings"'),'system settings router import missing');
assert(server.includes('app.use("/api/system-settings",systemSettingsRouter)'),'system settings router mount missing');
assert(bootstrap.includes('20260813_SYSTEM_SETTINGS_CENTER_V1.sql'),'system settings menu migration missing from bootstrap');
assert(menu.includes("'settings.general'"),'settings menu item missing');
assert(menu.includes("'/settings'"),'settings route missing');
assert(menu.includes("'admin'"),'admin settings permission missing');
assert(menu.includes("'manager'"),'manager settings view permission missing');
console.log('System settings center contract OK');
