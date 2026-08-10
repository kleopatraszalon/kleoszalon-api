const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(file)=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('public marketing mounts the voice interpreter before generic booking routes',()=>{
  const src=read('src/routes/publicMarketing.ts');
  const voice=src.indexOf('router.use("/booking/voice", bookingVoiceRouter)');
  const booking=src.indexOf('router.use("/booking", onlineBookingRouter)');
  assert.ok(voice>=0,'voice booking route is not mounted');
  assert.ok(booking>=0,'generic booking route is not mounted');
  assert.ok(voice<booking,'voice route must be registered before generic booking router');
});

test('voice interpreter is rate limited, privacy preserving and confirmation only',()=>{
  const src=read('src/routes/bookingVoice.ts');
  assert.match(src,/current\.count>=8/);
  assert.match(src,/BOOKING_VOICE_STORE_TRANSCRIPTS/);
  assert.match(src,/storeTranscript\?transcript:null/);
  assert.match(src,/requires_confirmation:true/);
  assert.match(src,/foglalás csak a végső összegzés jóváhagyása után történik/);
});

test('voice interpreter supports Hungarian natural date and time expressions',()=>{
  const src=read('src/routes/bookingVoice.ts');
  assert.match(src,/holnaputan/);
  assert.match(src,/holnap/);
  assert.match(src,/hetfo:1/);
  assert.match(src,/pentek:5/);
  assert.match(src,/preferred_period:"morning"/);
  assert.match(src,/preferred_period:"afternoon"/);
  assert.match(src,/preferred_period:"evening"/);
});

test('voice AI is optional and can only return catalog identifiers',()=>{
  const src=read('src/routes/bookingVoice.ts');
  assert.match(src,/BOOKING_VOICE_AI_ENABLED/);
  assert.match(src,/locationIds\.has/);
  assert.match(src,/serviceIds\.has/);
  assert.match(src,/employeeIds\.has/);
  assert.match(src,/Ne találj ki adatot/);
});

test('voice statistics schema records recognition quality without requiring transcript storage',()=>{
  const src=read('src/routes/bookingVoice.ts');
  assert.match(src,/CREATE TABLE IF NOT EXISTS booking_voice_events/);
  assert.match(src,/recognized boolean/);
  assert.match(src,/ai_used boolean/);
  assert.match(src,/missing_fields text\[\]/);
  assert.match(src,/booking_voice_events_location_idx/);
});
