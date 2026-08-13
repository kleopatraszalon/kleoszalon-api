const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const source=fs.readFileSync('src/routes/onlineBooking.ts','utf8');

test('online booking recovers a persisted appointment instead of returning a false 500',()=>{
  assert.match(source,/recovered persisted booking after response failure/);
  assert.match(source,/a\.start_time=\$3::timestamptz/);
  assert.match(source,/regexp_replace\(COALESCE\(cl\.phone/);
  assert.match(source,/return res\.status\(200\)\.json\(/);
  assert.match(source,/recovered:true/);
});

test('recovery runs only after rollback and keeps the real 500 fallback',()=>{
  const rollback=source.indexOf('await cx.query("ROLLBACK").catch');
  const recovery=source.indexOf('const persisted = await db.query',rollback);
  const fallback=source.indexOf('res.status(500).json({ error: "Az online foglalás mentése sikertelen.',recovery);
  assert.ok(rollback>=0&&recovery>rollback&&fallback>recovery);
});

test('appointment commit precedes best-effort work-order generation',()=>{
  const durable=source.indexOf('Az időpont a foglalás üzleti eredménye');
  const commit=source.lastIndexOf('await cx.query("COMMIT")',durable);
  const workOrder=source.indexOf('work order deferred',durable);
  assert.ok(commit>=0&&durable>commit&&workOrder>durable);
  assert.match(source,/persisted:true/);
});
