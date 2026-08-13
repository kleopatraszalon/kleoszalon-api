const fs=require('fs');
const assert=require('assert');

const service=fs.readFileSync('src/services/operationalAlertAutomation.ts','utf8');
const route=fs.readFileSync('src/routes/notifications.ts','utf8');

for(const marker of [
  'supplier_expiry_batches',
  'employee_documents',
  'complaints.sla_default_hours',
  'complaints.sla_warning_hours',
  'supplier.shelf_life_warning_days',
  'hr.document_expiry_warning_days',
  'vir_alert_preferences',
  'vir_staff_push_subscriptions',
  'vir_alert_deliveries',
  'sendEmail',
  'webpush.sendNotification',
  'cron.schedule("17 * * * *"',
  'runOperationalAlertAutomation',
]) assert(service.includes(marker),`missing automation marker: ${marker}`);

for(const marker of [
  'collectOperationalAlerts',
  'router.get("/preferences"',
  'router.put("/preferences"',
  'router.post("/push-subscriptions"',
  'router.get("/automation/summary"',
  'router.post("/automation/run"',
  'router.get("/automation/employee-documents"',
  'router.get("/automation/supplier-expiry-batches"',
  'supplier_expiry',
  'employee_document',
  'complaint_sla',
]) assert(route.includes(marker),`missing notification route marker: ${marker}`);

console.log('Operational alert automation contract OK');
