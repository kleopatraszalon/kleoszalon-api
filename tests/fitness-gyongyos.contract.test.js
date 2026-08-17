const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

const fitness=read('src/routes/fitness.ts');
const vir=read('src/routes/vir.ts');

test('Gyongyos Fitness is server-scoped to admin or the configured receptionist location',()=>{
  assert.match(fitness,/const isAdmin = .*includes\("admin"\)/);
  assert.match(fitness,/const isReceptionist = .*includes\("receptionist"\)/);
  assert.match(fitness,/admin \|\| \(receptionist && Boolean\(locationId\) && own === locationId\)/);
  assert.match(fitness,/FITNESS_GYONGYOS_ONLY/);
  assert.doesNotMatch(fitness,/location_manager.*allowed/);
  assert.doesNotMatch(fitness,/salon_manager.*allowed/);
});

test('Fitness has memberships, 24-7 access, products, promotions and maintenance domains',()=>{
  for(const table of ['vir_fitness_membership_plans','vir_fitness_memberships','vir_fitness_access_events','vir_fitness_promotions','vir_fitness_equipment','vir_fitness_equipment_maintenance']){
    assert.ok(fitness.includes(table),`${table} must exist in Fitness schema`);
  }
  assert.ok(fitness.includes('24_7'));
  assert.ok(fitness.includes('KLEO_FITNESS_GYONGYOS'));
  assert.ok(fitness.includes('KLEO_FITNESS_GYONGYOS_PRODUCTS'));
  assert.match(fitness,/\/equipment\/:id\/maintenance/);
});

test('OTIC bridge is separately authenticated and raw card identifiers are not returned to user routes',()=>{
  const bridgePos=vir.indexOf('router.use("/fitness/otic-bridge", fitnessOticBridgeRouter)');
  const authPos=vir.indexOf('router.use(requireAuth)');
  assert.ok(bridgePos>=0 && authPos>bridgePos,'OTIC bridge must be mounted before user JWT middleware');
  assert.match(fitness,/x-kleo-fitness-bridge-token/);
  assert.match(fitness,/timingSafeEqual/);
  assert.match(fitness,/otic_bridge_token_configured/);
  assert.match(fitness,/const \{ otic_bridge_token_hash, \.\.\.safe \} = s/);
  assert.match(fitness,/card_uid:undefined,card_id:undefined,identifier:undefined/);
  assert.match(fitness,/card_uid_hash=\$3,card_last4=\$4/);
});

test('OTIC decisions validate membership status, validity and access window',()=>{
  assert.match(fitness,/member\.status!=='ACTIVE'/);
  assert.match(fitness,/A bérlet még nem érvényes/);
  assert.match(fitness,/A bérlet lejárt/);
  assert.match(fitness,/planAllows\(occurred,member,Boolean\(s\.is_24_7_enabled\)\)/);
  assert.ok(fitness.includes("allow?'GRANTED':'DENIED'"));
});
