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

test('management improvement menu is self healing and management only',()=>{
  const route=read('src/routes/operationsQuality.ts');
  const menu=read('src/menu/ensureManagementImprovementMenu.ts');
  contains(route,['ensureManagementImprovementMenu','5_000','20_000','60_000']);
  contains(menu,['Vállalatirányítási eszközök','operations.improvement','Fejlesztési projektek és CAPA','/operations/improvement',"VALUES('admin'),('manager')",'can_approve=true','clearShortCache("menu:")']);
});

test('improvement schema persists project CAPA KPI approval and append-only audit records',()=>{
  const p=read('src/management/ensureManagementImprovement.ts');
  contains(p,['management_improvement_projects','management_improvement_actions','management_improvement_kpis','management_improvement_approvals','management_improvement_audit','analysis_data jsonb','approval_state','management_improvement_one_pending_approval_idx','management_improvement_audit_immutable']);
});

test('database boundary freezes approval evidence and prevents approval-state bypass',()=>{
  const p=read('src/management/ensureManagementImprovement.ts');
  contains(p,["NEW.approval_state='pending' AND NEW.status<>'review'","NEW.approval_state='approved' AND NEW.status NOT IN ('approved','closed')","NEW.status='review' AND NEW.approval_state<>'pending'","NEW.status IN ('approved','closed') AND NEW.approval_state<>'approved'","A pending jóváhagyási állapothoz függő jóváhagyási rekord szükséges.","Jóváhagyás csak igazolt vagy megszakított CAPA intézkedésekkel indítható.","Jóváhagyás előtt legalább egy teljes előtte/utána KPI szükséges.","A jóváhagyott projektállapothoz jóváhagyási bizonyíték szükséges.","Lezárt projekthez lezárási időbélyeg szükséges.","Projekt nem zárható le nem igazolt CAPA intézkedéssel.","Jóváhagyás alatt vagy után a projekt bizonyítéktartalma nem módosítható.","Jóváhagyás alatt vagy után CAPA/KPI bizonyíték nem módosítható."]);
});

test('improvement workflow is tenant scoped and approval is fail closed',()=>{
  const p=read('src/routes/managementImprovement.ts');
  contains(p,['resolveTenantIdentity','locationBelongsToTenant','tenant_id=$2::bigint','request-approval','before_value IS NOT NULL AND after_value IS NOT NULL','project.approval_state !== "pending"','Nincs függő jóváhagyási kérelem.','A projekt csak jóváhagyás után zárható le.','CAPA intézkedés eredményességét igazolni kell.']);
});

test('approval API matches DB readiness and returns business conflicts instead of false 500',()=>{
  const p=read('src/routes/managementImprovement.ts');
  contains(p,["String(error?.code || \"\") === \"23514\"","dbConstraint ? 409 : 500","management_improvement_actions WHERE project_id=$1 AND tenant_id=$2::bigint AND status NOT IN ('verified','cancelled')","intézkedés eredményességét igazolni vagy az intézkedést megszakítani kell."]);
});

test('all project mutations are audit trailed',()=>{
  const p=read('src/routes/managementImprovement.ts');
  contains(p,['project.created','project.updated','action.created','action.updated','action.deleted','kpi.created','kpi.updated','kpi.deleted','approval.requested','approval.approved','approval.rejected','project.closed']);
});