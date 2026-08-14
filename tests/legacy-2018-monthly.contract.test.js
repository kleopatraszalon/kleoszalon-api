const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('monthly 2018 evaluation freezes a manager-approved snapshot and keeps AI advisory only',()=>{
 const src=read('src/services/legacyEvaluationMonthly.ts');
 for(const marker of ['hr_legacy_monthly_reviews','manager_comment','guest_rating_count','ai_summary','snapshot','status=\'closed\'','ai_advisory_only:true'])assert.ok(src.includes(marker),`missing ${marker}`);
 assert.match(src,/Tilos elbocsátást, felvételt, előléptetést, béremelést\/bércsökkentést/);
 assert.match(src,/Folyamatban lévő hónap nem zárható le/);
});
test('monthly route exposes prepare ai comment and close operations',()=>{
 const src=read('src/routes/operationsQuality.ts');
 for(const marker of ['/legacy-2018/monthly/prepare','/legacy-2018/monthly/:id/ai','/legacy-2018/monthly/:id/close','updateLegacyMonthlyManagerComment'])assert.ok(src.includes(marker),`missing ${marker}`);
});
