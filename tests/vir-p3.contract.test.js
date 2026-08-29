const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const route=fs.readFileSync('src/routes/virP3.ts','utf8');const vir=fs.readFileSync('src/routes/vir.ts','utf8');
test('VIR P3 is management protected and mounted',()=>{assert.match(route,/router\.use\(requireManagement\)/);assert.match(vir,/router\.use\("\/p3", virP3Router\)/);assert.match(route,/tenant_id=\$2::uuid/)});
test('P3 churn radar is explainable and non autonomous',()=>{assert.match(route,/churn-radar/);assert.match(route,/churn_score/);assert.match(route,/explainable_cycle_recency_churn_v1/);assert.match(route,/autonomous_outreach: false/)});
test('P3 next visit predicts from client service cycles',()=>{assert.match(route,/next-visit/);assert.match(route,/LAG\(a0\.start_time\)/);assert.match(route,/predicted_next_visit/);assert.match(route,/service_cycle_prediction_v1/)});
test('P3 smart pricing is recommendation only',()=>{assert.match(route,/smart-pricing/);assert.match(route,/demand_index/);assert.match(route,/suggested_discount_percent/);assert.match(route,/automatic_price_changes: false/)});
test('P3 membership intelligence does not auto enroll',()=>{assert.match(route,/membership-intelligence/);assert.match(route,/membership_fit_score/);assert.match(route,/recommended_plan/);assert.match(route,/automatic_enrollment: false/)});
