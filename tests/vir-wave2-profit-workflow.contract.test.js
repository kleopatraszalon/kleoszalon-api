const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const engine=fs.readFileSync(path.join(root,'src/services/virWave2Engine.ts'),'utf8');
const api=fs.readFileSync(path.join(root,'src/routes/virWave2.ts'),'utf8');
const autopilot=fs.readFileSync(path.join(root,'src/routes/bookingV4Autopilot.ts'),'utf8');
const finalization=fs.readFileSync(path.join(root,'src/routes/workOrderFinalization.ts'),'utf8');

test('VIR Wave II contains all four roadmap pillars',()=>{
 assert.match(engine,/profitEngine/);
 assert.match(engine,/service_material_requirements/);
 assert.match(engine,/clientBrief/);
 assert.match(engine,/vir_workflow_rules/);
 assert.match(engine,/processWorkflowEvents/);
});

test('service recipes are versioned and include waste factor',()=>{
 assert.match(engine,/waste_percent/);
 assert.match(engine,/version int NOT NULL DEFAULT 1/);
 assert.match(engine,/version=service_material_requirements\.version\+1/);
 assert.match(api,/router\.put\('\/recipes\/:serviceId'/);
});

test('work order finalization already consumes recipe materials idempotently',()=>{
 assert.match(finalization,/JOIN service_material_requirements r ON r\.service_id=wi\.service_id AND r\.active=true/);
 assert.match(finalization,/movement_type='work_order_consumption'/);
 assert.match(finalization,/if\(workOrder\.stock_consumed_at\)return\{consumed:\[\],replenishment_requests:\[\],idempotent:true\}/);
 assert.match(finalization,/salon_stock_requests/);
});

test('Profit Engine accounts for material, labor and commission cost',()=>{
 assert.match(engine,/material_cost/);
 assert.match(engine,/hourly_wage/);
 assert.match(engine,/commission_percent/);
 assert.match(engine,/profit_per_minute/);
 assert.match(engine,/margin_percent/);
});

test('AI Client Brief is fail-soft and excludes free-text notes from its source payload',()=>{
 const brief=engine.slice(engine.indexOf('export async function clientBrief'),engine.indexOf('function readPath'));
 assert.match(brief,/client brief AI fallback/);
 assert.doesNotMatch(brief,/appointment.*notes/i);
 assert.match(brief,/recent_visits/);
 assert.match(brief,/top_products/);
});

test('Workflow Engine captures business events and materializes deduped actions',()=>{
 assert.match(engine,/trg_vir_workorder_workflow_event/);
 assert.match(engine,/trg_vir_appointment_workflow_event/);
 assert.match(engine,/UNIQUE\(event_id,rule_id,action_index\)/);
 assert.match(engine,/cooldown_minutes/);
 assert.match(engine,/NODE_ENV==='test'/);
});

test('Wave II is mounted without adding a new server route',()=>{
 assert.match(autopilot,/router\.use\("\/wave2", virWave2Router\)/);
 assert.match(api,/router\.get\('\/profit'/);
 assert.match(api,/router\.get\('\/client-brief\/:clientId'/);
 assert.match(api,/router\.post\('\/workflows\/process'/);
});
