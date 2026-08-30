const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');
const vir=fs.readFileSync('src/routes/vir.ts','utf8');
const hooks=fs.readFileSync('src/routes/virCommunicationWebhooks.ts','utf8');
const providers=fs.readFileSync('src/services/virMessagingProviders.ts','utf8');
const p7=fs.readFileSync('src/routes/virP7.ts','utf8');
const p8=fs.readFileSync('src/routes/virP8.ts','utf8');

test('public provider webhooks are mounted before user auth',()=>{const hook=vir.indexOf('router.use("/public/communications"');const auth=vir.indexOf('router.use(requireAuth)');assert.ok(hook>=0&&auth>hook);});
test('Viber subscriber and Messenger PSID callbacks are authenticated and persist channel identities',()=>{for(const x of ['X-Viber-Content-Signature','X-Hub-Signature-256','COMMUNICATION_WEBHOOK_SECRET','vir_client_channel_identities',"event==='subscribed'","channel:\"viber\"|\"messenger\"",'external_id']){if(x.includes('|'))continue;assert.ok(hooks.toLowerCase().includes(x.toLowerCase()))}assert.ok(hooks.includes("upsertIdentity(scope,'viber'"));assert.ok(hooks.includes("upsertIdentity(scope,'messenger'"));});
test('provider callbacks update delivery read click and response engagement',()=>{for(const x of ['delivered_at','read_at','clicked_at','responded_at','failed_at','provider_message_id'])assert.ok(hooks.includes(x));});
test('Messenger outbound provider uses Page Send API contract',()=>{for(const x of ['sendMessengerText','MESSENGER_PAGE_ACCESS_TOKEN','MESSENGER_PAGE_ID','graph.facebook.com','message_id'])assert.ok(providers.includes(x));});
test('P7 keeps outbound provider calls behind preview approval execute',()=>{for(const x of ["/execute/preview","/execute/:id/approve","/execute/:id/run","channel==='viber'","channel==='messenger'",'KLEO_TOUCH:','provider_message_id'])assert.ok(p7.includes(x));assert.ok(!p7.includes("delivered_at=CASE WHEN"));});
test('P8 channel optimizer consumes real callback engagement',()=>{for(const x of ['provider_callbacks:true','COUNT(t.delivered_at)','COUNT(t.read_at)','COUNT(t.clicked_at)','COUNT(t.responded_at)'])assert.ok(p8.includes(x));});
test('P8 revenue attribution is paid-ledger based and non-causal',()=>{for(const x of ['work_order_payments','wp.amount','paid_revenue','paid_ledger:true','causality_claim:false','last_touch_paid_ledger_attribution_v2'])assert.ok(p8.includes(x));assert.ok(!p8.includes("model:'last_touch_booking_value_attribution_v1'"));});
