const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('Stage17 record lifecycle is admin-only, soft-delete based and reversible',()=>{
  const facade=read('src/routes/clients.ts');
  const route=read('src/routes/systemHardening.ts');
  assert.match(facade,/system-hardening/);
  assert.match(route,/requireAdmin/);
  assert.match(route,/deleted_at/);
  assert.match(route,/deleted_by/);
  assert.match(route,/delete_reason/);
  assert.match(route,/\/:entity\/:id\/archive/);
  assert.match(route,/\/:entity\/:id\/restore/);
  assert.doesNotMatch(route,/router\.delete/);
  assert.match(route,/action:\s*"soft_delete"/);
  assert.match(route,/action:\s*"restore"/);
});

test('Stage17 audit redacts credentials and counts lifecycle actions',()=>{
  const writer=read('src/audit/systemAudit.ts');
  const audit=read('src/routes/auditLog.ts');
  assert.match(writer,/SENSITIVE_KEY/);
  assert.match(writer,/password/);
  assert.match(writer,/authorization/);
  assert.match(writer,/\[redacted\]/);
  assert.match(writer,/writeSystemAudit/);
  assert.match(audit,/soft_delete/);
  assert.match(audit,/restore/);
  assert.match(audit,/severity/);
  assert.match(audit,/location_id/);
});
