const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('voice stats API is authenticated, menu-protected and runtime-bootstrapped',()=>{
  const src=read('src/routes/transactions.ts');
  assert.match(src,/router\.use\(requireAuth\)/);
  assert.match(src,/booking-voice-stats/);
  assert.match(src,/ensureVoiceStatsReady/);
  assert.match(src,/requireMenuPermission\("appointments\.voice_stats","can_view"\)/);
});

test('voice stats menu and manager/admin permissions are seeded',()=>{
  const sql=read('src/sql/20260810_BOOKING_VOICE_STATS_V1.sql');
  assert.match(sql,/appointments\.voice_stats/);
  assert.match(sql,/\/appointments\/voice-booking-stats/);
  assert.match(sql,/VALUES\('admin'\),\('manager'\)/);
  assert.match(sql,/scope_type/);
  const boot=read('src/virSpec/ensureVirSpecModules.ts');
  assert.match(boot,/20260810_BOOKING_VOICE_STATS_V1\.sql/);
});

test('voice stats API exposes recognition AI conversion channel and privacy metrics',()=>{
  const src=read('src/routes/bookingVoiceStats.ts');
  assert.match(src,/recognition_rate/);
  assert.match(src,/conversion_rate/);
  assert.match(src,/voice_booking_share/);
  assert.match(src,/ai_usage_log/);
  assert.match(src,/online_voice/);
  assert.match(src,/online_bookings/);
  assert.match(src,/top_services/);
  assert.match(src,/recent_transcripts_exposed:false/);
  assert.doesNotMatch(src,/SELECT[^;]*v\.transcript[,\s]/i);
});
