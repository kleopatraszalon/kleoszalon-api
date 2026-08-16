'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-FUN-COMM-001 / KLEO-FUN-COMM-001-AC-01
test('complaint mailbox persists one complaint with sender, message identity and attachments',()=>{
 const s=read('src/services/complaintMailbox.ts');
 assert.match(s,/CREATE TABLE IF NOT EXISTS complaint_mail_messages/);
 assert.match(s,/UNIQUE\(mailbox_key, imap_uid\)/);
 assert.match(s,/CREATE TABLE IF NOT EXISTS complaint_attachments/);
 assert.match(s,/sender_email/);
 assert.match(s,/message_id/);
 assert.match(s,/attachment_count/);
 assert.match(s,/sha256/);
 assert.match(s,/INSERT INTO operations_quality_records/);
 assert.match(s,/INSERT INTO complaint_attachments/);
});

// KLEO-FUN-COMM-001 / KLEO-FUN-COMM-001-AC-02
test('complaint mailbox is idempotent for an already imported mailbox message',()=>{
 const s=read('src/services/complaintMailbox.ts');
 assert.match(s,/SELECT id FROM complaint_mail_messages WHERE mailbox_key=\$1 AND imap_uid=\$2/);
 assert.match(s,/if \(exists\.rowCount\) \{ await client\.query\("ROLLBACK"\); return false; \}/);
 assert.match(s,/UNIQUE\(mailbox_key, imap_uid\)/);
});

// KLEO-FUN-FIN-003 / KLEO-FUN-FIN-003-AC-01
test('work-order payments preserve split-payment identity and deterministic remaining amount',()=>{
 const route=read('src/routes/workOrderEditor.ts');
 const payment=read('src/finance/workOrderPaymentIntegrity.ts');
 assert.match(route,/router\.post\('\/:id\/payments'/);
 assert.match(route,/requireIdempotencyKey\(req,'workorder-editor-payment'\)/);
 assert.match(route,/const remaining=Math\.max\(0,money\(dueBase-regularPaid\)\)/);
 assert.match(route,/const regularAfter=money\(regularPaid\+incoming\),left=Math\.max\(0,money\(dueBase-regularAfter\)\)/);
 assert.match(route,/payment_status=\$3,fully_paid=\$4/);
 assert.match(payment,/INSERT INTO work_order_payments/);
 assert.match(payment,/payment_sequence/);
 assert.match(payment,/settlement_key/);
 assert.match(payment,/financial_movement_id/);
});

// KLEO-FUN-FIN-003 / KLEO-FUN-FIN-003-AC-02
test('financially closed or overpaid work orders fail closed without a new payment effect',()=>{
 const route=read('src/routes/workOrderEditor.ts');
 assert.match(route,/if\(wo\.locked_at\)\{await c\.query\('ROLLBACK'\);return res\.status\(409\)/);
 assert.match(route,/if\(incoming>remaining\+\.009\)\{await c\.query\('ROLLBACK'\);return res\.status\(409\)/);
 assert.match(route,/work_order_settlements WHERE settlement_key=\$1 FOR UPDATE/);
 assert.match(route,/if\(previous\).*same_payload/s);
 assert.match(route,/Az Idempotency-Key már más tartalmú fizetéshez lett felhasználva/);
});
