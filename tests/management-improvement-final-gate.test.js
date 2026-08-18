'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('management improvement final gate keeps API and database approval rules aligned',()=>{
  const api=read('src/routes/managementImprovement.ts');
  const schema=read('src/management/ensureManagementImprovement.ts');
  for(const marker of [
    "status NOT IN ('verified','cancelled')",
    'before_value IS NOT NULL AND after_value IS NOT NULL',
    'String(error?.code || "") === "23514"',
    'dbConstraint ? 409 : 500',
    'approval.requested','approval.approved','approval.rejected','project.closed'
  ]) assert.ok(api.includes(marker),`API marker missing: ${marker}`);
  for(const marker of [
    "NEW.approval_state='pending'",
    "a.status NOT IN ('verified','cancelled')",
    'k.before_value IS NOT NULL AND k.after_value IS NOT NULL',
    'management_improvement_audit_immutable',
    'management_improvement_guard_child_tenant'
  ]) assert.ok(schema.includes(marker),`DB guard missing: ${marker}`);
});