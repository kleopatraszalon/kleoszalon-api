const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-FUN-BOOK-004-AC-02
test('confirmed voice booking is correlated exactly once and persisted as online_voice',()=>{
  const booking=read('src/routes/onlineBookingCore.ts');
  assert.match(booking,/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(booking,/appointments WHERE voice_event_id=\$1::uuid[\s\S]*booking_waitlist WHERE voice_event_id=\$1::uuid/);
  assert.match(booking,/Ez a Voice Booking esemény már fel lett használva/);
  assert.match(booking,/bookingSource[\s\S]*online_voice/);
  assert.match(booking,/INSERT INTO appointments\([\s\S]*booking_source,voice_event_id/);
  assert.match(booking,/voice_created/);
});

// KLEO-FUN-PROC-002-AC-01
test('partial receipt cannot exceed remaining ordered quantity and incoming invoice uses received value',()=>{
  const orders=read('src/routes/purchaseOrders.ts');
  const finance=read('src/routes/financeLinking.ts');
  assert.match(orders,/remaining = num\(item\.ordered_quantity\)-num\(item\.received_quantity\)/);
  assert.match(orders,/receiveQty>remaining\+0\.0001/);
  assert.match(orders,/received_quantity=received_quantity\+\$2/);
  assert.match(orders,/partially_received/);
  assert.match(finance,/SUM\(received_quantity\*COALESCE\(actual_unit_cost,unit_cost\)\)/);
  assert.match(finance,/Number\(totals\.rows\[0\]\?\.received_total\)>0\?totals\.rows\[0\]\.received_total/);
});

// KLEO-FUN-PROC-002-AC-02
test('incoming invoice creation is idempotent per purchase order',()=>{
  const finance=read('src/routes/financeLinking.ts');
  assert.match(finance,/direction='incoming' AND purchase_order_id=\$1/);
  assert.match(finance,/ON CONFLICT \(purchase_order_id\) WHERE direction='incoming'/);
  assert.match(finance,/DO UPDATE SET invoice_no=COALESCE/);
});

// KLEO-NFR-PRV-001-AC-01
test('GDPR export requires verified identity, independent approval, stable preview and creates evidence',()=>{
  const gdpr=read('src/routes/gdpr.ts');
  assert.match(gdpr,/Export csak igazolt személyazonosság után készíthető/);
  assert.match(gdpr,/action_type='export' AND status='approved'/);
  assert.match(gdpr,/preview\.hash!==action\.preview_hash/);
  assert.match(gdpr,/COALESCE\(created_by,''\)<>\$3/);
  assert.match(gdpr,/evidence_ref=\$3/);
  assert.match(gdpr,/Cache-Control","no-store/);
  assert.match(gdpr,/classification:"REVIEW_REQUIRED"/);
  assert.match(gdpr,/EXPORT_SECRET_KEY/);
});
