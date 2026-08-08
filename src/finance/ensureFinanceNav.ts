import {readFile} from 'fs/promises';
import path from 'path';
import pool from '../db';
import {ensureHrV2} from '../hr/ensureHrV2';
import {ensureCustomerPortal} from '../customerPortal/ensureCustomerPortal';
import {ensureMenuHealth} from '../menu/ensureMenuHealth';

let ensurePromise:Promise<void>|null=null;

async function runSql(file:string){
  const sql=await readFile(path.join(__dirname,'..','sql',file),'utf8');
  await pool.query(sql);
}

export function ensureFinanceNav(){
  if(!ensurePromise){
    ensurePromise=(async()=>{
      await ensureHrV2();
      await ensureCustomerPortal();
      for(const file of [
        '20260807_CASHIER_FINANCIAL_CLOSE_V1.sql',
        '20260807_FINANCE_OPERATIONS_V2.sql',
        '20260807_payroll_accounting_v2.sql',
        '20260807_FINANCE_INVOICES_V3.sql',
        '20260808_FINANCE_NAV_SCHEMA_REPAIR_V6.sql',
        '20260808_NAV_ONLINE_INVOICE_V4.sql',
        '20260808_NAV_ONLINE_INVOICE_V5_LIFECYCLE.sql',
        '20260808_LOYALTY_CASHIER_V5.sql',
        '20260806_WORKORDER_STOCK_CONSUMPTION_V1.sql',
        '20260808_WORK_ORDER_FINALIZATION_V2.sql',
      ]) await runSql(file);
      await ensureMenuHealth();
    })().catch(err=>{ensurePromise=null;throw err});
  }
  return ensurePromise;
}
