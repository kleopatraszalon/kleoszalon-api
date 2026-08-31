const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('P20 uses validated ensemble forecasting with backtest and intervals',()=>{
  const src=read('src/routes/virP20.ts');
  assert.match(src,/ensemble_linear_weekday_momentum_v1/);
  assert.match(src,/backtest/);
  assert.match(src,/mape_percent/);
  assert.match(src,/revenue_lower/);
  assert.match(src,/revenue_upper/);
  assert.match(src,/automatic_execution:false/);
});

test('P21 is explainable and can only promote through P17 governance',()=>{
  const src=read('src/routes/virP21.ts');
  assert.match(src,/explainable_ai_decision_support_v1/);
  assert.match(src,/uses_p22_feedback:true/);
  assert.match(src,/INSERT INTO vir_p17_operations/);
  assert.match(src,/pending_approval/);
  assert.match(src,/requires_p17_approval:true/);
  assert.match(src,/direct_external_execution:false/);
});

test('P22 evaluates verified outcomes and feeds learning back to P21',()=>{
  const src=read('src/routes/virP22.ts');
  assert.match(src,/closed_loop_governed_optimization_v1/);
  assert.match(src,/p17_operation_must_be_verified/);
  assert.match(src,/optimization_score/);
  assert.match(src,/feedback_to_p21:true/);
  assert.match(src,/autonomous_policy_mutation:false/);
});

test('VIR root mounts P20 P21 and P22',()=>{
  const src=read('src/routes/vir.ts');
  for(const n of ['20','21','22'])assert.match(src,new RegExp(`router\\.use\\(\\"\\/p${n}\\", virP${n}Router\\)`));
});

test('P20-P22 schema keeps tenant guards and P17 foreign-key governance',()=>{
  const sql=read('src/migrations/20260831_003_vir_p20_p22_learning_loop.sql');
  assert.match(sql,/vir_p20_model_runs/);
  assert.match(sql,/vir_p21_decisions/);
  assert.match(sql,/vir_p22_cycles/);
  assert.match(sql,/REFERENCES vir_p17_operations/);
  assert.match(sql,/vir_p17_p19_enforce_location_tenant/);
});
