import {readFile} from 'fs/promises';
import path from 'path';
import pool from '../db';
import {ensureHrV2} from '../hr/ensureHrV2';
import {ensureMenuHealth} from '../menu/ensureMenuHealth';
import {ensureWorkOrderWorkflow} from '../workorders/ensureWorkOrderWorkflow';

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
    this.name='FinanceNavBootstrapError';this.stage=substage?`${stage}:${substage}`:stage;this.dbCode=cause?.code?String(cause.code):null;this.substage=substage;this.constraint=cause?.constraint?String(cause.constraint):null;(this as any).cause=cause;
  }
}
async function runSql(file:string){const sql=await readFile(path.join(__dirname,'..','sql',file),'utf8');await pool.query(sql)}
async function step(stage:string,fn:()=>Promise<any>){try{return await fn()}catch(error:any){if(error instanceof FinanceNavBootstrapError)throw error;throw new FinanceNavBootstrapError(stage,error)}}
export function ensureFinanceNav(){if(!ensurePromise){ensurePromise=(async()=>{await step('work_order_workflow',()=>ensureWorkOrderWorkflow(pool));await step('hr_v2',()=>ensureHrV2());for(const file of[
 '20260807_CASHIER_FINANCIAL_CLOSE_V1.sql','20260813_CASH_REGISTER_SESSIONS_V1.sql','20260813_CASHIER_ALTEGIO_STAGE13.sql','20260807_CRM_AUTOMATION_V1.sql','20260807_FINANCE_OPERATIONS_V2.sql','20260807_payroll_accounting_v2.sql','20260807_FINANCE_INVOICES_V3.sql','20260808_FINANCE_NAV_SCHEMA_REPAIR_V6.sql','20260808_NAV_ONLINE_INVOICE_V4.sql','20260808_NAV_ONLINE_INVOICE_V5_LIFECYCLE.sql','20260811_NAV_ONLINE_INVOICE_41A.sql','20260811_NAV_ONLINE_INVOICE_41B_XSD.sql','20260807_UAT_TEST_CENTER_V1.sql','20260807_UAT_SANDBOX_V2.sql','20260807_UAT_ISSUES_V3.sql','20260809_UAT_STAGE10_V1.sql'
])await step(`sql:${file}`,()=>runSql(file));await step('menu_health',()=>ensureMenuHealth())})().catch(err=>{ensurePromise=null;throw err})}return ensurePromise}
