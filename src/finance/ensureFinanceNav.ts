import {readFile} from 'fs/promises';
import path from 'path';
import pool from '../db';
import {ensureHrV2} from '../hr/ensureHrV2';
import {ensureMenuHealth} from '../menu/ensureMenuHealth';
import {ensureFinanceV5Menu} from './ensureFinanceV5Menu';
import {ensureWorkOrderWorkflow} from '../workorders/ensureWorkOrderWorkflow';
import {ensureFixedAssetSchema} from '../routes/fixedAssets';

let ensurePromise:Promise<void>|null=null;

export class FinanceNavBootstrapError extends Error{
  stage:string;
  dbCode:string|null;
  substage:string|null;
  constraint:string|null;
  constructor(stage:string,cause:any){
    const causeMessage=String(cause?.message||cause||'ismeretlen hiba');
    const substage=cause?.workOrderBootstrapSubstage?String(cause.workOrderBootstrapSubstage):null;
    super(`Finance/NAV bootstrap hiba [${substage?`${stage}:${substage}`:stage}]: ${causeMessage}`);
    this.name='FinanceNavBootstrapError';
    this.stage=substage?`${stage}:${substage}`:stage;
    this.dbCode=cause?.code?String(cause.code):null;
    this.substage=substage;
    this.constraint=cause?.constraint?String(cause.constraint):null;
    if(this.constraint)this.stage=`${this.stage}:${this.constraint}`;
    (this as any).cause=cause;
  }
}

async function runSql(file:string){const sql=await readFile(path.join(__dirname,'..','sql',file),'utf8');await pool.query(sql)}
async function runSqlOnce(file:string,version:string){
  const exists=await pool.query(`SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1`,[version]);
  if(exists.rowCount)return;
  await runSql(file);
}
async function step(stage:string,fn:()=>Promise<any>){try{return await fn()}catch(error:any){if(error instanceof FinanceNavBootstrapError)throw error;throw new FinanceNavBootstrapError(stage,error)}}

export function ensureFinanceNav(){
  if(!ensurePromise){
    ensurePromise=(async()=>{
      await step('work_order_workflow',()=>ensureWorkOrderWorkflow(pool));
      await step('hr_v2',()=>ensureHrV2());
      await step('fixed_assets_schema',()=>ensureFixedAssetSchema());
      for(const file of [
        '20260807_CASHIER_FINANCIAL_CLOSE_V1.sql','20260807_CRM_AUTOMATION_V1.sql','20260807_FINANCE_OPERATIONS_V2.sql','20260813_CASHIER_ALTEGIO_PARITY_V1.sql','20260813_CASHIER_ALTEGIO_PARITY_V2.sql','20260807_payroll_accounting_v2.sql','20260807_FINANCE_INVOICES_V3.sql','20260808_FINANCE_NAV_SCHEMA_REPAIR_V6.sql','20260808_NAV_ONLINE_INVOICE_V4.sql','20260808_NAV_ONLINE_INVOICE_V5_LIFECYCLE.sql','20260811_NAV_ONLINE_INVOICE_41A.sql','20260811_NAV_ONLINE_INVOICE_41B_XSD.sql','20260807_NOTIFICATION_CENTER_V1.sql','20260814_FINANCE_V5_PREFLIGHT_A_MASTER.sql','20260814_FINANCE_V5_PREFLIGHT_B_CATALOG.sql','20260813_FINANCE_ALTEGIO_V5.sql','20260816_FINANCIAL_INTEGRITY_V1.sql','20260816_DAY_CLOSE_GUARD_V1.sql','20260816_SAAS_CORE_V1.sql','20260816_SAAS_TENANT_ISOLATION_V2.sql','20260816_SAAS_ONBOARDING_V7.sql','20260816_SAAS_ADMIN_INVITATIONS_V8.sql','20260816_SAAS_BILLING_V4.sql','20260817_SAAS_LIFECYCLE_POLICY_V9.sql','20260817_SAAS_LIFECYCLE_OBSERVABILITY_V10.sql','20260817_SAAS_LIFECYCLE_OPS_ALERTS_V11.sql','20260817_SAAS_QUOTA_ENFORCEMENT_V12.sql','20260817_SAAS_PLAN_DOWNGRADE_GUARD_V13.sql','20260817_SAAS_PLAN_STATISTICAL_DEFAULTS_V14.sql','20260816_FRANCHISE_FINANCE_V5.sql','20260816_FRANCHISE_ACCOUNTING_V6.sql','20260816_ENTERPRISE_MARKETING_BRIDGE_V7A.sql','20260816_ENTERPRISE_INTEGRITY_V7.sql','20260816_WORKORDER_REVERSAL_API_V8.sql','20260816_CRM_LOYALTY_INTEGRITY_V9.sql','20260807_UAT_TEST_CENTER_V1.sql','20260807_UAT_SANDBOX_V2.sql','20260807_UAT_ISSUES_V3.sql','20260809_UAT_STAGE10_V1.sql','20260814_BOOKING_UAT_FINAL_V1.sql','20260816_REQUIREMENTS_TRACEABILITY_V1.sql','20260816_REQUIREMENTS_EVIDENCE_V2.sql','20260816_UAT_KLEO_MAPPING_V3.sql','20260816_UAT_AUTOMATION_STATUS_V4.sql','20260816_UAT_KLEO_MAPPING_V4_FEFO.sql','20260816_UAT_AUTOMATION_STATUS_V5_FEFO.sql','20260816_UAT_DAY_CLOSE_MAPPING_V6.sql','20260816_UAT_PROCUREMENT_RECEIPT_COST_MAPPING_V7.sql'
      ])await step(`sql:${file}`,()=>runSql(file));
      await step('sql:20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1.sql',()=>runSqlOnce('20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1.sql','20260826_LEGAL_ENTITIES_MULTI_COMPANY_V1'));
      await step('sql:20260826_LEGAL_ENTITIES_WORKORDER_GUARD_V2.sql',()=>runSqlOnce('20260826_LEGAL_ENTITIES_WORKORDER_GUARD_V2.sql','20260826_LEGAL_ENTITIES_WORKORDER_GUARD_V2'));
      await step('sql:20260826_LEGAL_ENTITIES_ACCOUNTING_DEFAULTS_V3.sql',()=>runSqlOnce('20260826_LEGAL_ENTITIES_ACCOUNTING_DEFAULTS_V3.sql','20260826_LEGAL_ENTITIES_ACCOUNTING_DEFAULTS_V3'));
      await step('sql:20260826_LEGAL_ENTITIES_PENDING_SELECTION_V4.sql',()=>runSqlOnce('20260826_LEGAL_ENTITIES_PENDING_SELECTION_V4.sql','20260826_LEGAL_ENTITIES_PENDING_SELECTION_V4'));
      await step('sql:20260826_LEGAL_ENTITIES_OPERATIONAL_DRAFT_V5.sql',()=>runSqlOnce('20260826_LEGAL_ENTITIES_OPERATIONAL_DRAFT_V5.sql','20260826_LEGAL_ENTITIES_OPERATIONAL_DRAFT_V5'));
      await step('sql:20260827_EXTERNAL_INVOICE_NAV_BRIDGE_V6.sql',()=>runSqlOnce('20260827_EXTERNAL_INVOICE_NAV_BRIDGE_V6.sql','20260827_EXTERNAL_INVOICE_NAV_BRIDGE_V6'));
      await step('menu_health',()=>ensureMenuHealth());
      await step('finance_v5_menu',()=>ensureFinanceV5Menu());
      await step('sql:20260810_RBAC_FAIL_CLOSED_V1.sql',()=>runSql('20260810_RBAC_FAIL_CLOSED_V1.sql'));
      await step('sql:20260814_ACCOUNTING_USER_RBAC_V1.sql',()=>runSql('20260814_ACCOUNTING_USER_RBAC_V1.sql'));
      await step('sql:20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2.sql',()=>runSqlOnce(
        '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2.sql',
        '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2'
      ));
      await step('sql:20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3.sql',()=>runSqlOnce(
        '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3.sql',
        '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3'
      ));
    })().catch(err=>{ensurePromise=null;throw err});
  }return ensurePromise;
}