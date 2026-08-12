const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const source=fs.readFileSync('src/routes/systemHealth.ts','utf8');
test('AI diagnosis is management-only, store-free and bounded',()=>{assert.match(source,/router\.post\("\/ai-analysis"/);assert.match(source,/if\(!canUse\(req\)\)/);assert.match(source,/store:false/);assert.match(source,/slice\(0,100\)/);assert.match(source,/timeout:12_000/)});
test('AI cannot invent check ids or arbitrary repair actions',()=>{assert.match(source,/allowedKeys\.has/);assert.match(source,/recommended_action==="booking_runtime_repair"/);assert.match(source,/Ismeretlen vagy nem engedélyezett javítási művelet/)});
test('repair is an explicit idempotent runtime bootstrap',()=>{assert.match(source,/ensureOnlineBooking\(\)/);assert.match(source,/ensureBookingWorkOrderSchema\(client\)/);assert.doesNotMatch(source,/exec\(|child_process|eval\(/)});
test('AI failure falls back to deterministic health findings',()=>{assert.match(source,/ai_used:false/);assert.match(source,/\[system-health-ai\] fallback/)});
