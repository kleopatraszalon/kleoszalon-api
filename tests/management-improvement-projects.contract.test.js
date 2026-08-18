const fs=require('fs');const path=require('path');
const read=p=>fs.readFileSync(path.join(process.cwd(),p),'utf8');

test('operations quality mounts database improvement project API',()=>{const p=read('src/routes/operationsQuality.ts');expect(p).toContain('managementImprovementRouter');expect(p).toContain('router.use("/improvement",managementImprovementRouter)')});

test('improvement schema persists project CAPA KPI approval and audit records',()=>{const p=read('src/management/ensureManagementImprovement.ts');for(const marker of ['management_improvement_projects','management_improvement_actions','management_improvement_kpis','management_improvement_approvals','management_improvement_audit','analysis_data jsonb','approval_state'])expect(p).toContain(marker)});

test('improvement workflow is tenant scoped and approval is fail closed',()=>{const p=read('src/routes/managementImprovement.ts');for(const marker of ['resolveTenantIdentity','locationBelongsToTenant','tenant_id=$2::bigint','request-approval','before_value IS NOT NULL AND after_value IS NOT NULL','approval_state!==\'pending\'','A projekt csak jóváhagyás után zárható le','CAPA intézkedés eredményességét igazolni kell'])expect(p).toContain(marker)});

test('all project mutations are audit trailed',()=>{const p=read('src/routes/managementImprovement.ts');for(const marker of ['project.created','project.updated','action.created','action.updated','action.deleted','kpi.created','kpi.updated','kpi.deleted','approval.requested','approval.approved','approval.rejected','project.closed'])expect(p).toContain(marker)});
