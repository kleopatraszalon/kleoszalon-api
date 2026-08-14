const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const timetable=fs.readFileSync('src/routes/timetable.ts','utf8');
const scheduleDay=fs.readFileSync('src/routes/schedule_day.ts','utf8');

for (const [name,source] of [['timetable',timetable],['schedule day',scheduleDay]]) {
  test(`${name} returns work-order-aware operational status`,()=>{
    assert.match(source,/AS operational_status/i);
    assert.match(source,/work_order_closed/);
    assert.match(source,/in_progress/);
    assert.match(source,/arrived/);
    assert.match(source,/locked_at/);
    assert.match(source,/archived_at/);
    assert.match(source,/to_jsonb\(a\)->>'work_order_id'/);
  });
}
