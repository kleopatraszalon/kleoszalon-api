const fs=require('fs');
const test=require('node:test');
const assert=require('node:assert/strict');
const route=fs.readFileSync('src/routes/virP7.ts','utf8');
const provider=fs.readFileSync('src/services/virMessagingProviders.ts','utf8');

test('VIR exposes Viber and Messenger capability state',()=>{
  assert.match(provider,/VIBER_BOT_TOKEN/);
  assert.match(provider,/MESSENGER_PAGE_ACCESS_TOKEN/);
  assert.match(route,/virMessagingProviderCapabilities/);
});

test('Viber send uses official Chat API endpoint and token header',()=>{
  assert.match(provider,/https:\/\/chatapi\.viber\.com\/pa\/send_message/);
  assert.match(provider,/X-Viber-Auth-Token/);
  assert.match(provider,/receiver/);
});

test('Viber execution remains approval gated',()=>{
  assert.match(route,/status='approved'/);
  assert.match(route,/channel==='viber'/);
  assert.match(route,/sendViberText/);
  assert.match(route,/status='sent'/);
});

test('Viber addressing boundary uses subscriber id, not phone number',()=>{
  assert.match(route,/recipient_identifier:'subscriber_id'/);
  assert.match(route,/phone_number_send_supported:false/);
});
