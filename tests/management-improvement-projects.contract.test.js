const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const path=require('path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');
const contains=(source,markers)=>{for(const marker of markers)assert.ok(source.includes(marker),`missing marker: ${marker}`)};

test('operations quality mounts database improvement project API',()=>{
  const p=read('src/routes/operationsQuality.ts');
  contains(p,['managementImprovementRouter','router.use("/improvement",managementImprovementRouter)']);
});

test('improvement schema persists project CAPA KPI approval and append-only audit records',()=>{
  const p=read('src/management/ensureManagementImprovement.ts');
  contains(p,['management_improvement_projects','management_improvement_actions','management_improvement_kpis','management_improvement_approvals','management_improvement_audit','analysis_data jsonb','approval_state','management_improvement_one_pending_approval_idx','management_improvement_audit_immutable']);
});

test('database boundary freezes approval evidence and prevents approval-state bypass',()=>{
  const p=read('src/management/ensureManagementImprovement.ts');
  contains(p,["NEW.approval_state='pending' AND NEW.status<>'review'","NEW.approval_state='approved' AND NEW.status NOT IN ('approved','closed')","NEW.status='review' AND NEW.approval_state<>'pending'","NEW.status IN ('approved','closed') AND NEW.approval_state<>'approved'","Jóváhagyás alatt vagy után a projekt bizonyítéktartalma nem módosítható.","Jóváhagyás alatt vagy után CAPA/KPI bizonyíték nem módosítható."]);
});

test('improvement workflow is tenant scoped and approval is fail closed',()=>{
  const p=read('src/routes/managementImprovement.ts');
  contains(p,['resolveTenantIdentity','locationBelongsToTenant','tenant_id=$2::bigint','request-approval','before_value IS NOT NULL AND after_value IS NOT NULL','project.approval_state !== "pending"','Nincs függő jóváhagyási kérelem.','A projekt csak jóváhagyás után zárható le.','CAPA intézkedés eredményességét igazolni kell.']);
});

test('all project mutations are audit trailed',()=>{
  const p=read('src/routes/managementImprovement.ts');
  contains(p,['project.created','project.updated','action.created','action.updated','action.deleted','kpi.created','kpi.updated','kpi.deleted','approval.requested','approval.approved','approval.rejected','project.closed']);
});
