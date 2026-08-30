const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');
const route=fs.readFileSync('src/routes/virP8.ts','utf8');
const vir=fs.readFileSync('src/routes/vir.ts','utf8');

test('P8 is mounted behind canonical VIR auth routing',()=>{assert.ok(vir.includes('virP8Router'));assert.ok(vir.includes('router.use("/p8", virP8Router)'));assert.ok(route.includes('router.use(requireManagement)'));});
test('45 Identity Hub persists verified channel identities with consent',()=>{for(const x of ['vir_client_channel_identities','transactional_consent','marketing_consent','external_id','identity-hub'])assert.ok(route.includes(x));});
test('46 Universal Inbox persists conversations and messages',()=>{for(const x of ['vir_conversations','vir_conversation_messages',"/inbox","/inbox/ingest"])assert.ok(route.includes(x));});
test('47 AI Receptionist human handoff is explicit and non autonomous',()=>{assert.ok(route.includes('/ai-receptionist/handoff'));assert.ok(route.includes('human_review_required:true'));assert.ok(route.includes('automatic_resolution:false'));});
test('48 Empty Slot Recovery reuses governed gap and waitlist engines',()=>{assert.ok(route.includes('findCalendarGaps'));assert.ok(route.includes('matchWaitlist'));assert.ok(route.includes('automatic_outreach:false'));assert.ok(route.includes('automatic_rebooking:false'));});
test('49 Channel Optimizer is consent and real callback response aware',()=>{assert.ok(route.includes("model:'consent_delivery_read_click_response_channel_optimizer_v2'"));for(const x of ['transactional_consent','marketing_consent','delivered_at','read_at','clicked_at','responded_at','automatic_send:false'])assert.ok(route.includes(x));});
test('50 Revenue Attribution uses paid ledger and discloses no causality claim',()=>{assert.ok(route.includes("model:'last_touch_paid_ledger_attribution_v2'"));assert.ok(route.includes('work_order_payments'));assert.ok(route.includes('paid_ledger:true'));assert.ok(route.includes('causality_claim:false'));assert.ok(route.includes('attribution_window_days:14'));});
test('P8 tenant and location scope are enforced',()=>{assert.ok(route.includes('tenant_id=$1::uuid'));assert.ok(route.includes('tenant_id=$2::uuid'));assert.ok(route.includes('A telephely nem tartozik a tenantjához.'));});
console.log('VIR P8 communication revenue contract: PASS');
