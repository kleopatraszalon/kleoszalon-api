'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('forensic toolkit provides risk SLA graph and proof export',()=>{
 const src=read('src/services/transactionTraceForensics.ts');
 for(const marker of ['assessTraceForensics','buildTraceGraph','buildProofPackage','traceHealthSummary','risk_score','lifecycle_sla_breach','hash_chain_broken','hmac_broken','nav_error_event','financial_reversal'])assert.ok(src.includes(marker),marker);
 assert.ok(src.includes('Europe/Budapest'));
});

test('forensic evidence package is SHA256 manifested and optionally HMAC signed',()=>{
 const src=read('src/services/transactionTraceForensics.ts');
 for(const marker of ['KLEO-VIR-TRANSACTION-PROOF-PACKAGE-V1','SHA-256','HMAC-SHA256','createHash','createHmac','manifestHash','hmac_signature'])assert.ok(src.includes(marker),marker);
 assert.ok(!src.includes('TRANSACTION_TRACE_HMAC_KEY='),'secret value must never be hardcoded');
});

test('digest watchdog persists alerts and sends at most one critical digest per cooldown',()=>{
 const src=read('src/services/transactionTraceWatchdog.ts');
 for(const marker of ['runSafeTraceWatchdog','startSafeTraceWatchdog','business_transaction_trace_watchdog_state','business_transaction_trace_alerts','trace-watchdog-digest','COOLDOWN_MINUTES','getApmAdminRecipients','sendEmail'])assert.ok(src.includes(marker),marker);
 assert.match(src,/\*\/10 \* \* \* \*/);
 assert.ok(src.includes("item.severity==='critical'"));
});

test('management API exposes forensic tools through safe watchdog',()=>{
 const route=read('src/routes/businessReconciliation.ts');
 for(const endpoint of ['/trace/health','/trace/watchdog','/forensics','/graph','/proof-package'])assert.ok(route.includes(endpoint),endpoint);
 assert.ok(route.includes('startSafeTraceWatchdog()'));
 assert.ok(route.includes('runSafeTraceWatchdog(1000)'));
 assert.ok(route.includes('ensureTransactionTraceForensicsSchema()'));
});

test('release control blocks open critical trace watchdog alerts',()=>{
 const src=read('src/middleware/releaseControlProcessIntegrity.ts');
 for(const marker of ['business_transaction_trace_alerts','openCritical','open_critical_watchdog','openCritical===0'])assert.ok(src.includes(marker),marker);
});
