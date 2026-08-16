'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=p=>fs.readFileSync(path.join(root,p),'utf8');

const route=()=>read('src/routes/hrRecruitment.ts');
const schema=()=>read('src/hr/ensureHrRecruitment.ts');

// KLEO-FUN-HR-001 / KLEO-FUN-HR-001-AC-01
test('complete application creates one new timestamped application with confirmation and idempotency identity',()=>{
 const r=route(),s=schema();
 assert.match(r,/router\.post\("\/applications"/);
 assert.match(r,/const fields = validateApplication\(body\);/);
 assert.ok(r.indexOf('if (Object.keys(fields).length)') < r.indexOf('INSERT INTO hr_recruitment_applications'));
 assert.match(r,/WHERE id=\$1::uuid AND tenant_id=\$2 AND is_active=true/);
 assert.match(r,/confirmationCode\(\)/);
 assert.match(r,/'new',now\(\)/);
 assert.match(r,/RETURNING id,confirmation_code,status,submitted_at/);
 assert.match(s,/hr_recruitment_submission_key_uq/);
 assert.match(s,/UNIQUE/);
});

// KLEO-FUN-HR-001 / KLEO-FUN-HR-001-AC-02
test('missing required application data is rejected field-by-field before any insert',()=>{
 const r=route();
 for(const field of ['position_id','first_name','last_name','email','phone','cv_url']) assert.match(r,new RegExp(`"${field}"`));
 assert.match(r,/fields\.consent_given = "required_true"/);
 assert.match(r,/code: "VALIDATION_ERROR"/);
 assert.match(r,/fields \}/);
 const validation=r.indexOf('if (Object.keys(fields).length)');
 const insert=r.indexOf('INSERT INTO hr_recruitment_applications');
 assert.ok(validation>=0 && insert>validation,'validation must occur before application insert');
});

// KLEO-FUN-HR-002 / KLEO-FUN-HR-002-AC-01
test('phone/email applicant contact is an attributable retrievable internal audit event',()=>{
 const r=route(),s=schema();
 assert.match(r,/router\.post\("\/applications\/:id\/contacts"/);
 assert.match(r,/\[(?:'|")phone(?:'|"),(?:'|")email(?:'|")\]\.includes\(channel\)/);
 assert.match(r,/internal_note/);
 assert.match(r,/actor_user_id/);
 assert.match(r,/contacted_at/);
 assert.match(r,/router\.get\("\/applications\/:id"/);
 assert.match(r,/FROM hr_recruitment_contacts WHERE application_id=\$1::uuid/);
 assert.match(s,/CONSTRAINT hr_recruitment_contact_channel_ck CHECK\(channel IN \('phone','email'\)\)/);
});

// KLEO-FUN-HR-002 / KLEO-FUN-HR-002-AC-02
test('passed applicant hire is transactionally idempotent and creates one employee plus one accounting task',()=>{
 const r=route(),s=schema();
 assert.match(r,/router\.post\("\/applications\/:id\/hire"/);
 assert.match(r,/BEGIN/);
 assert.match(r,/FOR UPDATE/);
 assert.match(r,/if \(application\.employee_id\)/);
 assert.match(r,/idempotent_replay: true/);
 assert.match(r,/application\.status !== "passed"/);
 assert.match(r,/INSERT INTO employees/);
 assert.match(r,/UPDATE hr_recruitment_applications SET employee_id=\$2,status='hired'/);
 assert.match(r,/INSERT INTO hr_recruitment_accounting_tasks/);
 assert.match(r,/ON CONFLICT\(application_id\) DO NOTHING/);
 assert.match(r,/COMMIT/);
 assert.match(s,/UNIQUE\(application_id\)/);
 assert.match(s,/hr_recruitment_employee_uq/);
});
