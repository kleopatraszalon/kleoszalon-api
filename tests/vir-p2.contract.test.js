const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const route=fs.readFileSync('src/routes/virP2.ts','utf8');const vir=fs.readFileSync('src/routes/vir.ts','utf8');const ai=fs.readFileSync('src/services/executiveAiAssistant.ts','utf8');
test('VIR P2 is management protected and mounted',()=>{assert.match(route,/router\.use\(requireManagement\)/);assert.match(vir,/router\.use\("\/p2", virP2Router\)/);assert.match(route,/tenant_id=\$2::uuid/)});
test('P2 copilot reuses canonical Executive AI',()=>{assert.match(route,/askExecutiveAssistant/);assert.match(route,/runExecutiveBrief/);assert.match(ai,/store:false/);assert.match(ai,/auton[oó]m/i)});
test('P2 anomalies reuse deterministic executive signals',()=>{assert.match(route,/collectExecutiveSignals/);assert.match(route,/severity==='critical'/);assert.match(route,/severity==='warning'/)});
test('P2 management summaries expose Budapest automation',()=>{assert.match(route,/08:10/);assert.match(route,/13:10/);assert.match(route,/20:10/);assert.match(route,/Europe\/Budapest/)});
test('P2 benchmark compares tenant salons without cross-tenant reads',()=>{assert.match(route,/WHERE l\.tenant_id=\$1::uuid/);assert.match(route,/benchmark_score/);assert.match(route,/revenue_vs_network_pct/)});
