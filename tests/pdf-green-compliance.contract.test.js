const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const root=path.join(__dirname,'..');
const read=(p)=>fs.readFileSync(path.join(root,p),'utf8');

function walk(dir){
  return fs.readdirSync(dir,{withFileTypes:true}).flatMap(entry=>{
    const p=path.join(dir,entry.name);
    return entry.isDirectory()?walk(p):[p];
  });
}

test('maintenance due X-day alert is rule-backed, scheduled and auditable',()=>{
  const src=read('src/compliance/pdfGreenCompliance.ts');
  assert.match(src,/MAINTENANCE_RULE_KEY\s*=\s*["']maintenance_due["']/);
  assert.match(src,/warning_value/);
  assert.match(src,/collectMaintenanceAlerts/);
  assert.match(src,/vir_operational_alert_events/);
  assert.match(src,/runMaintenanceAlertAutomation/);
  assert.match(src,/cron\.schedule\(["']23 \* \* \* \*["']/);
});

test('inventory has real max_quantity and min-max automatic replenishment',()=>{
  const src=read('src/compliance/inventoryMinMax.ts');
  assert.match(src,/ADD COLUMN IF NOT EXISTS max_quantity/);
  assert.match(src,/NEW\.max_quantity<NEW\.min_quantity/);
  assert.match(src,/kleo_minmax_auto_replenishment/);
  assert.match(src,/v_target-NEW\.quantity/);
  assert.match(src,/source[^\n]+minmax_auto/);
});

test('daily action generation fails closed unless free capacity is at least 50 percent',()=>{
  const src=read('src/routes/dailyActionAutoSelector.ts');
  assert.match(src,/DAILY_ACTION_MIN_FREE_CAPACITY_PCT\s*=\s*50/);
  assert.match(src,/scheduledMinutes\s*>\s*0\s*&&\s*freeCapacityPct\s*>=\s*DAILY_ACTION_MIN_FREE_CAPACITY_PCT/);
  assert.match(src,/DAILY_ACTION_CAPACITY_RULE/);
  assert.match(src,/capacity_rule_passed:\s*true/);
});

test('completed or overdue approval tasks create a distinct supervisor verification task',()=>{
  const src=read('src/compliance/pdfGreenCompliance.ts');
  assert.match(src,/kleo_create_supervisor_verification_task/);
  assert.match(src,/verification_of/);
  assert.match(src,/verification_reason/);
  assert.match(src,/q\.status='completed' OR \(q\.due_at<now\(\)/);
});

test('hiring queues and sends an automatic accounting e-mail',()=>{
  const src=read('src/compliance/pdfGreenCompliance.ts');
  assert.match(src,/trg_kleo_hire_accounting_email/);
  assert.match(src,/hr_recruitment_accounting_email_queue/);
  assert.match(src,/ACCOUNTING_EMAIL/);
  assert.match(src,/processAccountingHireEmails/);
  assert.match(src,/sendEmail\(\{/);
});

test('UI audit telemetry backend records important UI events without form values',()=>{
  const src=read('src/compliance/pdfGreenCompliance.ts');
  assert.match(src,/ui_audit_events/);
  assert.match(src,/\["click","route","window","dialog","submit","filter","export"\]/);
  assert.doesNotMatch(src,/e\.value/);
  const route=read('src/routes/pdfCompliance.ts');
  assert.match(route,/post\(["']\/ui-audit["']/);
});

test('business route sources do not physically delete protected business master records',()=>{
  const protectedTables=[
    'clients','employees','services','products','locations','hr_positions','suppliers',
    'work_orders','appointments','employment_contracts','service_material_requirements',
    'crm_tags','daily_action_campaigns','inventory_warehouses','inventory_units'
  ];
  const routeDir=path.join(root,'src','routes');
  const violations=[];
  for(const file of walk(routeDir).filter(p=>/\.(ts|js)$/.test(p))){
    const source=fs.readFileSync(file,'utf8');
    for(const table of protectedTables){
      const re=new RegExp(`DELETE\\s+FROM\\s+(?:public\\.)?${table}\\b`,'ig');
      if(re.test(source)) violations.push(`${path.relative(root,file)} -> ${table}`);
    }
  }
  assert.deepEqual(violations,[],`Physical DELETE is forbidden for protected business records:\n${violations.join('\n')}`);
});
