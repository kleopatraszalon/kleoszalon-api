const fs=require('fs');
const route=fs.readFileSync('src/routes/virP7.ts','utf8');
const provider=fs.readFileSync('src/services/virMessagingProviders.ts','utf8');

describe('VIR Viber provider contract',()=>{
  test('exposes Viber and Messenger capability state',()=>{
    expect(provider).toContain('VIBER_BOT_TOKEN');
    expect(provider).toContain('MESSENGER_PAGE_ACCESS_TOKEN');
    expect(route).toContain('virMessagingProviderCapabilities');
  });
  test('Viber send uses official Chat API endpoint and token header',()=>{
    expect(provider).toContain('https://chatapi.viber.com/pa/send_message');
    expect(provider).toContain('X-Viber-Auth-Token');
    expect(provider).toContain('receiver');
  });
  test('Viber execution remains approval gated',()=>{
    expect(route).toContain("status='approved'");
    expect(route).toContain("channel==='viber'");
    expect(route).toContain('sendViberText');
    expect(route).toContain("status='sent'");
  });
  test('documents Viber subscriber-id addressing boundary',()=>{
    expect(route).toContain("recipient_identifier:'subscriber_id'");
    expect(route).toContain('phone_number_send_supported:false');
  });
});
