const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');

const auth=fs.readFileSync('src/routes/auth.ts','utf8');
const menu=fs.readFileSync('src/middleware/menuPermission.ts','utf8');
const legalSql=fs.readFileSync('src/sql/20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1.sql','utf8');

test('admin idle unlock failure sends a security email and returns a dedicated code',()=>{
  assert.match(auth,/idle_unlock\?: boolean/);
  assert.match(auth,/const idleUnlock = req\.body\?\.idle_unlock === true/);
  assert.match(auth,/idleUnlock && isAdminRole\(user\.role\)/);
  assert.match(auth,/sendEmail\(\{/);
  assert.match(auth,/ADMIN_IDLE_UNLOCK_FAILED/);
});

test('receptionist checkout remains explicitly allowed at own location',()=>{
  assert.match(menu,/menuCode === "finance\.checkout"[\s\S]*roles\.includes\("receptionist"\)[\s\S]*req\.accessScope = "own_location"/);
});

test('legal entity bootstrap does not shadow SQL alias r with a PLpgSQL record variable',()=>{
  assert.match(legalSql,/check_row record/);
  assert.doesNotMatch(legalSql,/\bDECLARE[\s\S]{0,250}\br record;/);
});
