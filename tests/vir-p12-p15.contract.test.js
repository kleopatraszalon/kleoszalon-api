const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');
const vir=fs.readFileSync('src/routes/vir.ts','utf8');
const p12=fs.readFileSync('src/routes/virP12.ts','utf8');
const p13=fs.readFileSync('src/routes/virP13.ts','utf8');
const p14=fs.readFileSync('src/routes/virP14.ts','utf8');
const p15=fs.readFileSync('src/routes/virP15.ts','utf8');

test('VIR P12-P15 are mounted behind canonical VIR routing',()=>{
  for(const x of ['/p12','/p13','/p14','/p15']) assert.ok(vir.includes(`router.use("${x}"`),`missing ${x}`);
});
test('P12 orchestrates journey without automatic customer mutation',()=>{
  for(const x of ['/journey/:clientId','/next-step/:clientId','/recovery-queue','automatic_customer_mutation:false']) assert.ok(p12.includes(x),`missing ${x}`);
});
test('P13 protects revenue without automatic charge or discount',()=>{
  for(const x of ['/protection/preview','/loyalty-health/:clientId','/save-offer/preview','automatic_charge:false','automatic_discount:false']) assert.ok(p13.includes(x),`missing ${x}`);
});
test('P14 previews workforce changes only',()=>{
  for(const x of ['/workforce-pressure','/capacity-gaps','/service-bottlenecks','/shift-plan/preview','automatic_roster_change:false']) assert.ok(p14.includes(x),`missing ${x}`);
});
test('P15 keeps approval separate from execution',()=>{
  for(const x of ['/command-center','/action-plans/preview','/action-plans/:id/approve','execution_enabled:false','A jóváhagyás nem hajtja végre az operatív műveletet.']) assert.ok(p15.includes(x),`missing ${x}`);
});
