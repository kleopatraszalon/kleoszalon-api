const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const bootstrap=fs.readFileSync(path.join(process.cwd(),'src','saas','ensureSaasCommercialModel.ts'),'utf8');
const tenantContext=fs.readFileSync(path.join(process.cwd(),'src','middleware','tenantContext.ts'),'utf8');
const migration=fs.readFileSync(path.join(process.cwd(),'src','sql','20260818_SAAS_COMMERCIAL_MODEL_V15.sql'),'utf8');

test('commercial catalogue sets the approved VIR SaaS list prices',()=>{
  for(const expected of [
    ["start","29900","299000"],
    ["pro","59900","599000"],
    ["franchise","149900","1499000"],
    ["enterprise","299900","2999000"],
  ]){
    const [code,monthly,annual]=expected;
    assert.match(bootstrap,new RegExp(`monthly_price=${monthly}`));
    assert.match(bootstrap,new RegExp(`annual_price=${annual}`));
    assert.match(migration,new RegExp(`monthly_price=${monthly}`));
    assert.match(migration,new RegExp(`annual_price=${annual}`));
    assert.match(bootstrap,new RegExp(`WHERE code='${code}'`));
  }
});

test('START and PRO have a 14-day trial and enforced user/location limits',()=>{
  assert.match(bootstrap,/name='START'.*max_locations=1, max_users=5, trial_days=14/s);
  assert.match(bootstrap,/name='PRO'.*max_locations=1, max_users=15, trial_days=14/s);
  assert.match(bootstrap,/name='NETWORK \/ FRANCHISE'.*max_locations=5, max_users=50, trial_days=0/s);
});

test('trial policy is enforced at database level for non-trial packages',()=>{
  assert.match(bootstrap,/CREATE OR REPLACE FUNCTION enforce_saas_trial_policy/);
  assert.match(bootstrap,/SAAS_TRIAL_NOT_AVAILABLE/);
  assert.match(bootstrap,/subscriptions_trial_policy_guard/);
  assert.match(migration,/BEFORE INSERT OR UPDATE OF plan_id,status,trial_ends_at ON subscriptions/);
});

test('business model keeps zero booking commission and recommended PRO positioning',()=>{
  assert.match(bootstrap,/booking_commission_percent=0/g);
  assert.match(bootstrap,/name='PRO'.*recommended=true/s);
  assert.match(bootstrap,/extra_location_price=19900/);
  assert.match(bootstrap,/ai_plus_price=9900/);
  assert.match(bootstrap,/white_label_price=39900/);
  assert.match(bootstrap,/branded_app_price=49900/);
});

test('tenant context applies the commercial catalogue after SaaS core bootstrap',()=>{
  assert.match(tenantContext,/ensureSaasCommercialModel/);
  assert.match(tenantContext,/await ensureSaasCore\(\);\s*await ensureSaasCommercialModel\(\);/s);
});
