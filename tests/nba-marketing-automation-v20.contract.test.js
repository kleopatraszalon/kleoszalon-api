const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const route=read('src/routes/nbaMarketingAutomation.ts');
const clients=read('src/routes/clients.ts');
const sql=read('src/sql/20260819_NBA_MARKETING_AUTOMATION_V20.sql');

test('NBA marketing bridge is tenant scoped and mounted before generic intelligence router',()=>{
  assert.ok(route.includes('requireTenantContext'));
  assert.ok(route.includes('tenant_id'));
  assert.ok(clients.includes("router.use('/intelligence/marketing',nbaMarketingAutomationRouter)"));
  assert.ok(clients.indexOf("'/intelligence/marketing'")<clients.indexOf("'/intelligence'"));
});

test('only accepted NBA actions can create marketing jobs',()=>{
  assert.ok(route.includes("ev.action_status!==\"accepted\""));
  assert.ok(route.includes('NBA_ACTION_NOT_ACCEPTED'));
  assert.ok(route.includes('crm_next_best_action_events'));
});

test('consent is fail closed and rechecked before dispatch',()=>{
  for(const marker of ['marketing_consent','email_consent','sms_consent','phone_consent','consent_snapshot','dispatch_blocked'])assert.ok(route.includes(marker),marker);
  assert.ok(route.includes('const check=consentFor(job.action_code,job.channel'));
  assert.ok(route.includes('Nincs aktív marketing-hozzájárulás'));
});

test('explicit approval is default and auto dispatch is off by default',()=>{
  assert.ok(sql.includes('auto_dispatch boolean NOT NULL DEFAULT false'));
  assert.ok(sql.includes('require_explicit_approval boolean NOT NULL DEFAULT true'));
  assert.ok(route.includes('/jobs/:id/approve'));
  assert.ok(route.includes('/jobs/:id/send'));
});

test('supports email SMS push queue and callback with attribution and audit trail',()=>{
  for(const channel of ['email','sms','push','callback'])assert.ok(route.includes(`\"${channel}\"`),channel);
  assert.ok(route.includes('sendEmail'));
  assert.ok(route.includes('sendSms'));
  assert.ok(route.includes('waiting_provider'));
  assert.ok(route.includes('callback_ready'));
  assert.ok(route.includes('utm_source'));
  assert.ok(route.includes('attribution_key'));
  assert.ok(route.includes('crm_nba_marketing_job_events'));
});
