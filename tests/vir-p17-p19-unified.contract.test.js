const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('P17 exposes governed lifecycle and blocks direct external execution',()=>{
  const src=read('src/routes/virP17.ts');
  assert.match(src,/pending_approval/);
  assert.match(src,/approved/);
  assert.match(src,/executed/);
  assert.match(src,/verified/);
  assert.match(src,/rolled_back/);
  assert.match(src,/external_side_effects:false/);
  assert.match(src,/tenant_context_required/);
});

test('P18 promotes proposals into P17 instead of executing business side effects',()=>{
  const src=read('src/routes/virP18.ts');
  assert.match(src,/human_approval_required:true/);
  assert.match(src,/direct_external_execution:false/);
  assert.match(src,/INSERT INTO vir_p17_operations/);
  assert.match(src,/status='pending_approval'/);
  assert.match(src,/promoted_from_p18/);
});

test('P19 offers 7 30 and 90 day predictive horizons with explicit limitations',()=>{
  const src=read('src/routes/virP19.ts');
  assert.match(src,/supported_horizons:\[7,30,90\]/);
  assert.match(src,/deterministic_trend_v1/);
  assert.match(src,/not a guarantee of future revenue/);
  assert.match(src,/automatic_execution:false/);
});

test('VIR root mounts P17 P18 and P19',()=>{
  const src=read('src/routes/vir.ts');
  assert.match(src,/router\.use\("\/p17", virP17Router\)/);
  assert.match(src,/router\.use\("\/p18", virP18Router\)/);
  assert.match(src,/router\.use\("\/p19", virP19Router\)/);
});
