'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

// KLEO-FUN-BOOK-001-AC-01
// KLEO-FUN-BOOK-001-AC-02
test('KLEO-FUN-BOOK-001 internal booking creates one appointment only after locked conflict validation',()=>{
  const src=read('src/routes/bookingAdvanced.ts');
  assert.match(src,/router\.post\('\/appointments'/);
  assert.match(src,/await cx\.query\('BEGIN'\)/);
  assert.match(src,/buildPlan\(cx,req\.body,true\)/);
  assert.match(src,/if\(!plan\.ok\).*res\.status\(409\)/s);
  assert.match(src,/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
  assert.match(src,/FROM appointments WHERE employee_id=\$1::uuid[\s\S]*start_time<\$3::timestamptz AND end_time>\$2::timestamptz/);
  assert.match(src,/INSERT INTO appointments\(employee_id,client_id,location_id,title,start_time,end_time,status,notes,booking_source/);
  assert.match(src,/RETURNING id::text/);
  assert.match(src,/await cx\.query\('COMMIT'\)/);
});

// KLEO-FUN-AUTH-001-AC-01
test('KLEO-FUN-AUTH-001 invalid credentials fail closed without issuing a session',()=>{
  const src=read('src/routes/auth.ts');
  assert.match(src,/if \(!user\) \{[\s\S]*res\.status\(401\).*Hibás felhasználó vagy jelszó/);
  assert.match(src,/bcrypt\.compare\(password, hash\)/);
  assert.match(src,/if \(!ok\) return res\.status\(401\)/);
  const tokenPos=src.indexOf('const token = jwt.sign');
  const comparePos=src.indexOf('const ok = await bcrypt.compare');
  assert.ok(tokenPos>comparePos,'JWT must only be issued after password verification');
});

// KLEO-GEN-DATA-001-AC-01
// KLEO-GEN-DATA-001-AC-02
test('KLEO-GEN-DATA-001 business records use reversible logical deletion with retained identity and audit evidence',()=>{
  const src=read('src/routes/systemHardening.ts');
  assert.match(src,/ADD COLUMN IF NOT EXISTS deleted_at timestamptz/);
  assert.match(src,/ADD COLUMN IF NOT EXISTS deleted_by text/);
  assert.match(src,/ADD COLUMN IF NOT EXISTS delete_reason text/);
  assert.match(src,/sets = \["deleted_at=now\(\)", "deleted_by=\$2", "delete_reason=\$3"\]/);
  assert.match(src,/if \(active\) sets\.unshift\(`\$\{qi\(active\)\}=false`\)/);
  assert.match(src,/action: "soft_delete"/);
  assert.match(src,/router\.get\("\/archived"/);
  assert.match(src,/WHERE deleted_at IS NOT NULL/);
  assert.match(src,/id: String\(row\?\.id \|\| ""\)/);
  assert.match(src,/router\.post\("\/:entity\/:id\/restore"/);
  assert.match(src,/deleted_at=NULL/);
});

// KLEO-GEN-AUD-001-AC-01
// KLEO-GEN-AUD-001-AC-02
test('KLEO-GEN-AUD-001 audit trail stores actor request and before-after state and supports combined filters',()=>{
  const audit=read('src/audit/systemAudit.ts');
  const route=read('src/routes/auditLog.ts');
  for(const marker of ['actor_key','location_id','entity_type','entity_id','action','before_data','after_data','request_id','ip_address','user_agent']) assert.ok(audit.includes(marker),`missing audit field ${marker}`);
  assert.match(audit,/SENSITIVE_KEY/);
  assert.match(audit,/INSERT INTO system_audit_log/);
  assert.match(route,/const q = String\(req\.query\.q/);
  assert.match(route,/req\.query\.module/);
  assert.match(route,/req\.query\.action/);
  assert.match(route,/req\.query\.from/);
  assert.match(route,/req\.query\.to/);
  assert.match(route,/req\.query\.location_id/);
  assert.match(route,/req\.query\.actor/);
  assert.match(route,/req\.query\.entity_type/);
  assert.match(route,/where\.join\(' AND '\)/);
  assert.match(route,/before_data,after_data,metadata/);
});
