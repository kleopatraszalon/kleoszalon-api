const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('recommendations are persisted and governance protected',()=>{
  const src=read('src/services/exceptionCapaImprovementRecommendation.ts');
  assert.match(src,/CREATE TABLE IF NOT EXISTS exception_capa_improvement_recommendations/);
  assert.match(src,/status IN\('monitoring','recommended','dismissed'\)/);
  assert.match(src,/dismissed recommendation requires at least 10 characters/i);
  assert.match(src,/dismissed_score/);
  assert.match(src,/score>=dismissedScore\+15/);
});

test('critical recurrent and multi-case CAPA signals drive recommendation scoring',()=>{
  const src=read('src/services/exceptionCapaImprovementRecommendation.ts');
  for(const marker of ['critical_severity','high_severity','repeated_exception','exception_outbreak','multiple_cases','multiple_sources','capa_overdue'])assert.ok(src.includes(marker),marker);
  assert.match(src,/score>=50\|\|severity==='critical'\|\|clusterType==='recurrence'\|\|caseCount>=3/);
  assert.match(src,/metric_key:'exception_case_count'/);
  assert.match(src,/target_value:0/);
});

test('suggested due date never reuses an already expired CAPA deadline',()=>{
  const src=read('src/services/exceptionCapaImprovementRecommendation.ts');
  assert.match(src,/function earlierFutureDate/);
  assert.match(src,/candidate<=Date\.now\(\)/);
  assert.match(src,/computedDue=earlierFutureDate/);
});

test('automatic recommendation scheduler runs after the CAPA candidate cycle',()=>{
  const src=read('src/services/exceptionCapaImprovementRecommendation.ts');
  assert.match(src,/12,27,42,57 \* \* \* \*/);
  assert.match(src,/syncExceptionCapaImprovementRecommendations/);
  assert.match(src,/NODE_ENV==='test'/);
});

test('recommendation API is management mounted and tenant-location guarded',()=>{
  const route=read('src/routes/exceptionCapaImprovementRecommendations.ts');
  const notifications=read('src/routes/notifications.ts');
  for(const endpoint of ['/intelligence/capa/:id/improvement-recommendation','/intelligence/capa/:id/improvement-recommendation/refresh','/intelligence/capa/:id/improvement-recommendation/dismiss'])assert.ok(route.includes(endpoint),endpoint);
  assert.match(route,/locationBelongsToTenant/);
  assert.match(route,/resolveTenantIdentity/);
  assert.match(notifications,/requireManagement,exceptionCapaImprovementRecommendationsRouter/);
});

test('recommendation never bypasses project approval governance',()=>{
  const recommendation=read('src/services/exceptionCapaImprovementRecommendation.ts');
  const bridge=read('src/services/exceptionCapaImprovement.ts');
  assert.doesNotMatch(recommendation,/INSERT INTO management_improvement_projects/);
  assert.match(bridge,/Fejlesztési projekt csak ember által jóváhagyott CAPA rekordból indítható/);
  assert.match(recommendation,/can_promote:safe\(capa\.status\)==='approved'/);
});
