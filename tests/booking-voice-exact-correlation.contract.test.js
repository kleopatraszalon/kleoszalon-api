const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('Voice interpretation returns the durable event id created in booking_voice_events',()=>{
  const src=read('src/routes/bookingVoice.ts');
  assert.match(src,/RETURNING id::text/);
  assert.match(src,/voice_event_id:voiceEventId/);
  assert.ok(src.indexOf('RETURNING id::text')<src.indexOf('voice_event_id:voiceEventId'));
});

test('online booking schema persists one correlation id on appointments and waitlist',()=>{
  const src=read('src/booking/ensureOnlineBooking.ts');
  assert.match(src,/ADD COLUMN IF NOT EXISTS voice_event_id uuid/);
  assert.match(src,/appointments_voice_event_uq/);
  assert.match(src,/booking_waitlist_voice_event_uq/);
  assert.match(src,/source_snapshot[\s\S]*voice_event_id/);
});

test('voice event use is fresh intent-scoped and atomically one-shot across final outcomes',()=>{
  const src=read('src/routes/onlineBookingCore.ts');
  assert.match(src,/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(src,/Date\.now\(\)-24\*3600_000/);
  assert.match(src,/allowedIntents\.includes/);
  assert.match(src,/FROM appointments WHERE voice_event_id=\$1::uuid[\s\S]*FROM booking_waitlist WHERE voice_event_id=\$1::uuid/);
  assert.match(src,/validateVoiceEvent\(cx,requestedVoiceEventId,\["book"\]\)/);
  assert.match(src,/validateVoiceEvent\(cx,requestedVoiceEventId,\["book","waitlist"\]\)/);
});

test('public booking and waitlist store and echo the correlation id without requiring it during rolling deploy',()=>{
  const src=read('src/routes/onlineBookingCore.ts');
  assert.match(src,/booking_source,voice_event_id,cancellation_token/);
  assert.match(src,/voice_event_id:voiceEventId/);
  assert.match(src,/source,voice_event_id\)/);
  assert.match(src,/RETURNING id,status,created_at,voice_event_id::text/);
  assert.doesNotMatch(src,/if\s*\(!requestedVoiceEventId\).*Voice Booking/);
});

test('Voice stats conversion is event-correlated and retains legacy aggregate visibility',()=>{
  const src=read('src/routes/bookingVoiceStats.ts');
  assert.match(src,/exact_book_conversions/);
  assert.match(src,/a\.voice_event_id=v\.id/);
  assert.match(src,/conversion_rate:pct\(exactBookConversions,voiceBookIntents\)/);
  assert.match(src,/legacy_aggregate_conversion_rate/);
  assert.match(src,/conversion_tracking_coverage/);
  assert.match(src,/mode:'exact_voice_event_id'/);
});

test('recent Voice stats expose outcomes without exposing transcript text',()=>{
  const src=read('src/routes/bookingVoiceStats.ts');
  assert.match(src,/converted_to_booking/);
  assert.match(src,/booking_status/);
  assert.match(src,/converted_to_waitlist/);
  assert.match(src,/recent_transcripts_exposed:false/);
  assert.doesNotMatch(src,/SELECT[^`]*v\.transcript[,\s]/);
});

test('stats bootstrap installs booking correlation schema before querying it',()=>{
  const src=read('src/booking/ensureBookingVoiceStats.ts');
  assert.match(src,/ensureOnlineBooking/);
  assert.ok(src.indexOf('await ensureOnlineBooking()')<src.indexOf('await db.query(sql)'));
});
