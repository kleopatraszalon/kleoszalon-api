const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('operational VIR intelligence uses canonical BIGINT tenant boundary',()=>{
  const src=read('src/routes/virIntelligence.ts');
  assert.match(src,/tenant_id=\$2::bigint/);
  assert.match(src,/tenant_id=\$1::bigint/);
  assert.doesNotMatch(src,/tenant_id=\$2::uuid/);
  assert.match(src,/router\.use\('\/p23',virP23Router\)/);
  assert.match(src,/router\.use\('\/p24',virP24Router\)/);
  assert.match(src,/router\.use\('\/p25',virP25Router\)/);
});

test('digital twin aggregates real VIR domains without production mutation',()=>{
  const src=read('src/routes/virP23P25Shared.ts');
  for(const token of ['buildP20Forecast','readKpis','findCalendarGaps','upcomingRiskCandidates','profitEngine','product_stock_balances'])assert.match(src,new RegExp(token));
  assert.match(src,/business_digital_twin_v1/);
  assert.match(src,/production_mutation:false/);
});

test('what-if simulator bounds every business lever and remains simulation-only',()=>{
  const shared=read('src/routes/virP23P25Shared.ts');
  const route=read('src/routes/virP24.ts');
  for(const token of ['price_delta_percent','staff_hours_delta_percent','promotion_discount_percent','no_show_reduction_percent','stock_availability_delta_percent','demand_delta_percent'])assert.match(shared,new RegExp(token));
  assert.match(shared,/what_if_simulator_v1/);
  assert.match(route,/production_mutation:false/);
});

test('optimizer is multi-objective and can only promote into P17 pending approval',()=>{
  const route=read('src/routes/virP25.ts');
  const shared=read('src/routes/virP23P25Shared.ts');
  for(const token of ['revenue','profit','utilization','retention','staff_balance','stock_resilience'])assert.match(shared,new RegExp(token));
  assert.match(route,/multi_objective_business_optimizer_v1/);
  assert.match(route,/approval_layer:'P17'/);
  assert.match(route,/direct_execution:false/);
  assert.match(shared,/INSERT INTO vir_p17_operations/);
  assert.match(shared,/pending_approval/);
});

test('P23-P25 persistence is tenant guarded',()=>{
  const sql=read('src/migrations/20260831_004_vir_p23_p25_business_twin_optimizer.sql');
  for(const table of ['vir_p23_twin_snapshots','vir_p24_scenario_runs','vir_p25_optimization_runs'])assert.match(sql,new RegExp(table));
  assert.match(sql,/tenant_id bigint NOT NULL REFERENCES tenants\(id\)/);
  assert.match(sql,/REFERENCES vir_p17_operations/);
  assert.match(sql,/vir_p17_p19_enforce_location_tenant/);
});