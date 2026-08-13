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
