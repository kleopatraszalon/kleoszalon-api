const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=file=>fs.readFileSync(path.join(process.cwd(),file),'utf8');

test('Voice Booking interpret is protected by PostgreSQL-backed middleware before the router',()=>{
  const publicMarketing=read('src/routes/publicMarketing.ts');
  assert.match(publicMarketing,/import bookingVoiceRateLimit from "\.\.\/booking\/voiceRateLimit"/);
  assert.match(publicMarketing,/router\.use\("\/booking\/voice",\s*bookingVoiceRateLimit,\s*bookingVoiceRouter\)/);
});

test('distributed limiter uses one atomic PostgreSQL counter per client and minute',()=>{
  const src=read('src/booking/voiceRateLimit.ts');
  assert.match(src,/CREATE TABLE IF NOT EXISTS booking_voice_rate_limits/);
  assert.match(src,/PRIMARY KEY\(client_key_hash,window_start\)/);
  assert.match(src,/date_trunc\('minute',now\(\)\)/);
  assert.match(src,/ON CONFLICT\(client_key_hash,window_start\)/);
  assert.match(src,/request_count=booking_voice_rate_limits\.request_count\+1/);
  assert.doesNotMatch(src,/new Map/);
});

test('rate-limit client identity is stored only as a one-way hash and supports optional secret salt',()=>{
  const src=read('src/booking/voiceRateLimit.ts');
  assert.match(src,/BOOKING_VOICE_RATE_LIMIT_SALT/);
  assert.match(src,/createHmac\("sha256",salt\)/);
  assert.match(src,/createHash\("sha256"\)/);
  assert.doesNotMatch(src,/remoteIdentity\(req\)[\s\S]{0,120}db\.query/);
});

test('distributed limiter returns standard headers, 429 metadata and fails closed on DB errors',()=>{
  const src=read('src/booking/voiceRateLimit.ts');
  assert.match(src,/X-RateLimit-Limit/);
  assert.match(src,/X-RateLimit-Remaining/);
  assert.match(src,/Retry-After/);
  assert.match(src,/rate_limit_backend:"postgresql"/);
  assert.match(src,/voice_rate_limit_unavailable/);
  assert.match(src,/res\.status\(503\)/);
});

test('limiter is configurable, bounded and cleans old windows',()=>{
  const src=read('src/booking/voiceRateLimit.ts');
  assert.match(src,/BOOKING_VOICE_RATE_LIMIT_PER_MINUTE/);
  assert.match(src,/Math\.min\(120,Math\.max\(1/);
  assert.match(src,/window_start<now\(\)-interval '1 day'/);
});
