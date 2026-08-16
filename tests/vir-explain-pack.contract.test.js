const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const sql=fs.readFileSync(path.join(__dirname,'..','scripts','performance','vir_explain_analyze.sql'),'utf8');

test('VIR EXPLAIN pack covers all heavy report query shapes',()=>{
  for(const token of ['vir_dashboard_summary','vir_revenue_series','appointment_services','vw_vir_source_performance','vw_vir_cancellation_stats','vw_vir_kiosk_conversion','vw_vir_signage_campaign_impact'])assert.match(sql,new RegExp(token));
  assert.match(sql,/EXPLAIN \(ANALYZE,BUFFERS,SETTINGS,WAL,SUMMARY,FORMAT TEXT\)/);
});

test('VIR EXPLAIN pack inventories indexes and remains read-only',()=>{
  assert.match(sql,/pg_stat_user_indexes/);
  assert.match(sql,/pg_indexes/);
  assert.doesNotMatch(sql,/\bCREATE\s+INDEX\b/i);
  assert.doesNotMatch(sql,/\bDROP\s+INDEX\b/i);
  assert.doesNotMatch(sql,/\bUPDATE\s+[a-z_]/i);
  assert.doesNotMatch(sql,/\bDELETE\s+FROM\b/i);
});
