const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const route=read('src/routes/customerIntelligence.ts');
const clients=read('src/routes/clients.ts');
const sql=read('src/sql/20260819_CUSTOMER_INTELLIGENCE_NBA_V19.sql');

test('Customer Intelligence v19 is tenant and management scoped',()=>{
  assert.ok(route.includes('requireTenantContext'));
  assert.ok(route.includes('requireManagement'));
  assert.ok(route.includes('tenant_id'));
  assert.ok(route.includes('CUSTOMER_INTELLIGENCE_TENANT_SCOPE_UNAVAILABLE'));
  assert.ok(clients.includes("router.use('/intelligence',customerIntelligenceRouter)"));
});

test('Next Best Action engine is explainable and consent-aware',()=>{
  for(const action of ['FIRST_VISIT','WIN_BACK_60','REBOOK_30','NO_SHOW_PROTECTION','VIP_RETENTION','BIRTHDAY_OFFER','CONSENT_REFRESH','UPCOMING_CONFIRMATION','CROSS_SELL']) assert.ok(route.includes(action),`missing action ${action}`);
  assert.ok(route.includes('marketing_consent'));
  assert.ok(route.includes('suggested_channel'));
  assert.ok(route.includes('automatic_sending: false'));
  assert.ok(route.includes('action_reason'));
  assert.ok(route.includes('priority'));
});

test('Next Best Action decisions are auditable',()=>{
  assert.ok(route.includes('crm_next_best_action_events'));
  assert.ok(sql.includes('crm_next_best_action_events'));
  for(const status of ['accepted','dismissed','completed']) assert.ok(route.includes(status));
  assert.ok(route.includes('NBA_RECOMMENDATION_CHANGED'));
  assert.ok(route.includes('recommendation_version'));
});
