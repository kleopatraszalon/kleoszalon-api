const fs=require('fs');
const assert=require('assert');

const engine=fs.readFileSync('src/services/alertRuleEngine.ts','utf8');
const route=fs.readFileSync('src/routes/alertRuleAdmin.ts','utf8');

for(const marker of [
  'vir_alert_rules',
  'vir_alert_rule_audit',
  'vir_alert_delivery_attempts',
  'scope_type',
  'scope_id',
  'supplier_expiry',
  'employee_document',
  'complaint_sla',
  'level2_after_hours',
  'level3_after_hours',
  'Szalonvezető',
  'Üzletvezető',
  'Admin',
  'collectRuleDrivenAlerts',
  'runAlertRuleAutomation',
  'listAlertDeliveryLog',
  'retryAlertDelivery',
  'supplier.shelf_life_warning_days',
  'hr.document_expiry_warning_days',
  'complaints.sla_default_hours',
  'complaints.sla_warning_hours',
]) assert(engine.includes(marker),`missing rule engine marker: ${marker}`);

for(const marker of [
  'router.get("/rules"',
  'router.put("/rules/:ruleKey"',
  'router.delete("/rules/:ruleKey"',
  'router.get("/deliveries"',
  'router.post("/deliveries/:id/retry"',
  'router.get("/summary"',
  'router.post("/run"',
  'requireAdmin',
  'requireManagement',
]) assert(route.includes(marker),`missing alert admin route marker: ${marker}`);

assert(engine.includes('source="escalation"') || engine.includes('source: "escalation"'),'escalation delivery source missing');
assert(engine.includes("cron.schedule(\"17 * * * *\""),'hourly rule scheduler missing');
console.log('Alert rule escalation contract OK');
