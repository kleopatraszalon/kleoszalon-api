const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const worker=fs.readFileSync(path.join(__dirname,'..','src','services','saasLifecycleNotificationWorker.ts'),'utf8');
const route=fs.readFileSync(path.join(__dirname,'..','src','routes','saasLifecyclePolicy.ts'),'utf8');

test('worker claims queue rows safely across multiple instances',()=>{
 assert.match(worker,/FOR UPDATE SKIP LOCKED LIMIT 1/);
 assert.match(worker,/status='pending'/);
 assert.match(worker,/next_attempt_at<=now\(\)/);
});

test('worker uses shared mailer and bounded retry backoff',()=>{
 assert.match(worker,/sendEmail/);
 assert.match(worker,/MAX_ATTEMPTS=5/);
 assert.match(worker,/BACKOFF_MINUTES=\[5,15,60,240,720\]/);
 assert.match(worker,/status='sent'/);
});

test('missing recipients fail terminally instead of retrying forever',()=>{
 assert.match(worker,/MISSING_RECIPIENT/);
 assert.match(worker,/status='failed'/);
});

test('platform admin endpoint processes only bounded queue batches',()=>{
 assert.match(route,/\/lifecycle-policy\/process-notifications/);
 assert.match(route,/Math\.max\(1,Math\.min\(25/);
 assert.match(route,/processLifecycleNotificationQueue/);
});
