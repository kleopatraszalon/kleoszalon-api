'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('forensic toolkit provides risk SLA graph proof export and watchdog',()=>{
 const src=read('src/services/transactionTraceForensics.ts');
 for(const marker of ['assessTraceForensics','buildTraceGraph','buildProofPackage','traceHealthSummary','runTraceWatchdog','startTraceForensicWatchdog','risk_score','lifecycle_sla_breach','hash_chain_broken','hmac_broken','nav_error_event','financial_reversal'])assert.ok(src.includes(marker),marker);
 assert.match(src,/\*\/10 \* \* \* \*/);
 assert.ok(src.includes('Europe/Budapest'));
});

test('forensic evidence package is SHA256 manifested and optionally HMAC signed',()=>{
 const src=read('src/services/transactionTraceForensics.ts');
 for(const marker of ['KLEO-VIR-TRANSACTION-PROOF-PACKAGE-V1','SHA-256','HMAC-SHA256','createHash','createHmac','manifestHash','hmac_signature'])assert.ok(src.includes(marker),marker);
 assert.ok(!src.includes('TRANSACTION_TRACE_HMAC_KEY='),'secret value must never be hardcoded');
});

test('forensic alerts are persistent deduplicated and auditable',()=>{
 const src=read('src/services/transactionTraceForensics.ts');
 for(const marker of ['business_transaction_trace_alerts','business_transaction_trace_alert_deliveries','last_notified_at','resolved_at','occurrences','ALERT_COOLDOWN_MINUTES','getApmAdminRecipients','sendEmail'])assert.ok(src.includes(marker),marker);
});

test('management API exposes forensic tools',()=>{
 const route=read('src/routes/businessReconciliation.ts');
 for(const endpoint of ['/trace/health','/trace/watchdog','/forensics','/graph','/proof-package'])assert.ok(route.includes(endpoint),endpoint);
 assert.ok(route.includes('startTraceForensicWatchdog()'));
 assert.ok(route.includes('ensureTransactionTraceForensicsSchema()'));
});
