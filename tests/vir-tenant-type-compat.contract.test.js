const fs=require('fs');
const path=require('path');
const test=require('node:test');
const assert=require('node:assert/strict');

const dbSource=fs.readFileSync('src/db.ts','utf8');
const migration=fs.readFileSync('src/migrations/20260831_005_vir_tenant_identity_compat.sql','utf8');

test('legacy VIR BIGINT = UUID tenant comparisons are normalized before pg execution',()=>{
  assert.match(dbSource,/export function normalizeLegacyTenantSql/);
  assert.ok(dbSource.includes('tenant_id)\\s*=\\s*(\\$\\d+)::uuid'), 'forward tenant UUID comparison guard missing');
  assert.ok(dbSource.includes('::text=$2::text'), 'type-neutral tenant equality normalization missing');
  assert.ok(dbSource.includes('args[0] = normalizeQueryArg(args[0])'), 'query normalization must run before raw pg query execution');
});

test('legacy VIR support-table UUID tenant keys converge without losing historical ids',()=>{
  assert.ok(migration.includes("udt_name = 'uuid'"), 'migration must target legacy UUID tenant columns');
  assert.ok(migration.includes("table_name LIKE 'vir\\_%' ESCAPE '\\'"), 'migration must be scoped to VIR-owned tables');
  assert.ok(migration.includes('ALTER COLUMN tenant_id TYPE text USING tenant_id::text'), 'migration must preserve UUID values losslessly as text');
  assert.ok(migration.includes('RAISE EXCEPTION'), 'migration must fail closed when UUID tenant columns remain');
});

test('every legacy VIR route using an explicit tenant UUID cast goes through the shared normalized db pool',()=>{
  const routeDir='src/routes';
  const files=fs.readdirSync(routeDir).filter(name=>/^vir.*\.ts$/i.test(name));
  const legacy=[];
  for(const name of files){
    const source=fs.readFileSync(path.join(routeDir,name),'utf8');
    if(/tenant_id\s*=\s*\$\d+::uuid/i.test(source)||/\$\d+::uuid\s*=\s*(?:\w+\.)?tenant_id/i.test(source)){
      legacy.push(name);
      assert.match(source,/from\s+["']\.\.\/db["']/,`${name} bypasses shared db compatibility layer`);
    }
  }
  assert.ok(legacy.length>=5,'expected legacy VIR routes to be covered by the compatibility audit');
});
