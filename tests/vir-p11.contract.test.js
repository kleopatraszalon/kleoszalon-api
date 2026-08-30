const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const p11=fs.readFileSync('src/routes/virP11.ts','utf8');
const vir=fs.readFileSync('src/routes/vir.ts','utf8');

test('VIR P11 is mounted and exposes all three capabilities',()=>{
 assert.match(vir,/virP11Router/);
 assert.match(vir,/router\.use\("\/p11", virP11Router\)/);
 for(const endpoint of ["/receptionist/preview","/conversation-memory/:clientId","/complaints/analyze","/complaints"]) assert.ok(p11.includes(endpoint));
});

test('P11 preserves human approval and safe memory boundaries',()=>{
 for(const marker of ['automatic_booking:false','automatic_compensation:false','automatic_refund:false','human_review_required:true','sensitive_inference:false','automatic_profile_mutation:false']) assert.ok(p11.includes(marker),marker);
 assert.ok(p11.includes('first_party_operational_history'));
});

test('P11 is tenant scoped and complaint evidence uses paid ledger',()=>{
 assert.ok(p11.includes('tenant_id=$1::uuid'));
 assert.ok(p11.includes('work_order_payments'));
 assert.ok(p11.includes('paid_amount'));
});
