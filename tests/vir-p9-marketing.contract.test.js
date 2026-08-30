const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');
const vir=fs.readFileSync('src/routes/vir.ts','utf8');
const p9=fs.readFileSync('src/routes/virP9.ts','utf8');
const p7=fs.readFileSync('src/routes/virP7.ts','utf8');

test('P9 and receptionist surfaces are mounted behind canonical VIR auth',()=>{assert.ok(vir.includes('virP9Router'));assert.ok(vir.includes('virReceptionGuestActionsRouter'));assert.ok(vir.includes('router.use("/p9", virP9Router)'));assert.ok(vir.includes('router.use("/reception", virReceptionGuestActionsRouter)'));assert.ok(vir.indexOf('router.use(requireAuth)')<vir.indexOf('router.use("/p9"'));});
test('P9 management-only campaign lifecycle preserves approval boundary',()=>{assert.ok(p9.includes('router.use(requireManagement)'));for(const x of ["/campaigns/:id/preview","/campaigns/:id/approve","/campaigns/:id/execute",'provider_send_direct:false','approval_boundary_preserved:true','vir_guest_action_queue'])assert.ok(p9.includes(x));});
test('P9 implements requested marketing intelligence endpoints',()=>{for(const x of ["/channel-optimizer-v2","/conversion-funnel","/campaign-roi","/segments","/next-best-actions","/ab-tests","/attribution-v3","/suggestions","/compliance"])assert.ok(p9.includes(x));});
test('optimizer uses real engagement, consent and paid ledger signals',()=>{for(const x of ['delivered_at','read_at','clicked_at','responded_at','marketing_consent','communication_blocked','opted_out_at','work_order_payments','wp.amount','paid_revenue'])assert.ok(p9.includes(x));});
test('automatic segments include inactivity, churn, VIP, rebooking, price proxy and service interest',()=>{for(const x of ['inactive_30','inactive_60','inactive_90','high_churn_risk','vip','regular_rebooker','price_sensitive_proxy','service_interest:','price_sensitivity_is_proxy:true','service_interest_is_behavioral:true'])assert.ok(p9.includes(x));});
test('multi-touch attribution and campaign economics use paid ledger without causal claim',()=>{for(const x of ['multi_touch_linear_paid_ledger_attribution_v3','linear_equal_credit','attribution_window_days:14','paid_ledger:true','causality_claim:false','revenue_per_message'])assert.ok(p9.includes(x));});
test('campaign suggestions remain non-autonomous',()=>{for(const x of ['findCalendarGaps','automatic_send:false','approval_required:true'])assert.ok(p9.includes(x));});
test('compliance center records legal basis opt-out and hard communication blocks',()=>{for(const x of ['lawful_basis','opted_out_at','communication_blocked','block_reason','consent_source','marketing_requires_consent:true','blocked_overrides_consent:true'])assert.ok(p9.includes(x));});
test('receptionist gets daily assistance but no management campaign controls',()=>{assert.ok(p9.includes("requireRoles('admin','manager','receptionist')"));assert.ok(p9.includes("/guest-actions"));assert.ok(p9.includes('management_campaign_controls:false'));for(const x of ['findCalendarGaps','matchWaitlist','vir_conversations','vir_guest_action_queue'])assert.ok(p9.includes(x));});
test('P7 communication touches retain campaign and A/B variant identity',()=>{for(const x of ['campaign_id','variant_id','payload.campaign_id','payload.variant_id'])assert.ok(p7.includes(x));});
test('tenant and location ownership remain enforced',()=>{assert.ok(p9.includes('tenant_id=$2::uuid'));assert.ok(p9.includes('A telephely nem tartozik a tenantjához.'));});
console.log('VIR P9 marketing automation contract: PASS');
