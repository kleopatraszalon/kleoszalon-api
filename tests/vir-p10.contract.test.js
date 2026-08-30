const fs=require('fs');const test=require('node:test');const assert=require('node:assert/strict');
const p=fs.readFileSync('src/routes/virP10.ts','utf8');const v=fs.readFileSync('src/routes/vir.ts','utf8');
test('VIR P10 is management protected',()=>assert.ok(p.includes('router.use(requireManagement)')));
test('VIR P10 exposes all endpoints',()=>['/dynamic-offers','/empty-slot-autopilot','/revenue-guard','/next-best-offers','/promotion-simulator'].forEach(x=>assert.ok(p.includes(x),x)));
test('VIR P10 keeps human approval boundaries',()=>{assert.ok(p.includes('automatic_discount:false'));assert.ok(p.includes('automatic_booking:false'));assert.ok(p.includes('automatic_campaign:false'))});
test('VIR P10 uses paid ledger economics',()=>{assert.ok(p.includes('work_order_payments'));assert.ok(p.includes('paid_revenue'))});
test('VIR P10 is mounted',()=>assert.ok(v.includes('router.use("/p10", virP10Router)')));
