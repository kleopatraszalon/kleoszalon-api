const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('CAPA improvement command queue is tenant-location scoped',()=>{
  const src=read('src/services/exceptionCapaImprovementQueue.ts');
  assert.match(src,/JOIN locations tenant_location ON tenant_location\.id::text=rc\.location_id AND tenant_location\.tenant_id=\$1::bigint/);
  assert.match(src,/LEFT JOIN exception_capa_improvement_links l ON l\.capa_id=c\.id AND l\.tenant_id=\$1::bigint/);
  assert.doesNotMatch(src,/rc\.location_id IS NULL/);
});

test('CAPA improvement queue exposes management-ready prioritisation signals',()=>{
  const src=read('src/services/exceptionCapaImprovementQueue.ts');
  for(const marker of ['ready_to_promote','project_created','owner_missing','high_risk','critical_open','overdue','average_score'])assert.ok(src.includes(marker),marker);
  assert.match(src,/r\.status='recommended' AND c\.status='approved' AND l\.project_id IS NULL/);
  assert.match(src,/r\.score DESC/);
});

test('CAPA improvement queue supports operational filters',()=>{
  const src=read('src/services/exceptionCapaImprovementQueue.ts');
  for(const marker of ['filters.status','filters.capa_status','filters.risk','filters.owner','filters.project','filters.overdue','filters.ready_to_promote','filters.q'])assert.ok(src.includes(marker),marker);
});

test('static queue endpoints are declared before dynamic CAPA recommendation endpoint',()=>{
  const route=read('src/routes/exceptionCapaImprovementRecommendations.ts');
  const summary=route.indexOf("/intelligence/capa/improvement-recommendations/summary");
  const list=route.indexOf("/intelligence/capa/improvement-recommendations'");
  const dynamic=route.indexOf("/intelligence/capa/:id/improvement-recommendation");
  assert.ok(summary>=0&&list>=0&&dynamic>=0);
  assert.ok(summary<dynamic&&list<dynamic);
  assert.match(route,/queueScope/);
  assert.match(route,/locationBelongsToTenant/);
});
