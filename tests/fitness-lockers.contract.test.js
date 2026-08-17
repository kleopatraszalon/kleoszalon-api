const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Gyongyos locker module is mounted with bridge before JWT and staff routes after JWT',()=>{
 const vir=read('src/routes/vir.ts');
 assert.match(vir,/fitnessLockerRouter/);
 assert.match(vir,/fitnessLockerBridgeRouter/);
 const bridge=vir.indexOf('router.use("/fitness/locker-bridge"');
 const auth=vir.indexOf('router.use(requireAuth)');
 const staff=vir.indexOf('router.use("/fitness/lockers"');
 assert.ok(bridge>=0&&bridge<auth,'locker bridge must use its own token before JWT middleware');
 assert.ok(staff>auth,'staff locker routes must require user authentication');
});

test('locker backend hardens 20 compartments, card privacy, bridge token and allocation concurrency',()=>{
 const src=read('src/routes/fitnessLockers.ts');
 assert.match(src,/const LOCKER_COUNT = 20/);
 assert.match(src,/locker_no BETWEEN 1 AND 20/);
 assert.match(src,/controller_channel BETWEEN 1 AND 24/);
 assert.match(src,/FOR UPDATE SKIP LOCKED/);
 assert.match(src,/card_uid_hash/);
 assert.match(src,/sha256\(card\)/);
 assert.doesNotMatch(src,/card_uid\s+text/,'raw card UID must not be persisted');
 assert.match(src,/timingSafeEqual/);
 assert.match(src,/bridge_token_hash/);
 assert.match(src,/LOCKER_BRIDGE_AUTH_FAILED/);
 assert.match(src,/state='QUEUED'/);
 assert.match(src,/DOOR_OPEN/);
 assert.match(src,/DOOR_CLOSED/);
 assert.match(src,/FITNESS_GYONGYOS_ONLY/);
 assert.match(src,/isReception\(req\).*location_id/s);
});

test('locker scan reopens an active assignment and only allocates an actually free locker',()=>{
 const src=read('src/routes/fitnessLockers.ts');
 assert.match(src,/a\.card_uid_hash=\$2 AND a\.status='ACTIVE'/);
 assert.match(src,/l\.status='AVAILABLE'/);
 assert.match(src,/NOT EXISTS\(SELECT 1 FROM vir_fitness_locker_assignments/);
 assert.match(src,/NO_FREE_LOCKER/);
 assert.match(src,/OPEN_COMMAND|CARD_OPEN/);
});
