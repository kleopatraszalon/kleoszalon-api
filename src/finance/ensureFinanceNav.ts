import {readFile} from 'fs/promises';
import path from 'path';
import pool from '../db';
import {ensureHrV2} from '../hr/ensureHrV2';
import {ensureMenuHealth} from '../menu/ensureMenuHealth';
import {ensureWorkOrderWorkflow} from '../workorders/ensureWorkOrderWorkflow';

let ensurePromise:Promise<void>|null=null;

async function runSql(file:string){
  const sql=await readFile(path.join(__dirname,'..','sql',file),'utf8');
  await pool.query(sql);
}

export function ensureFinanceNav(){
  if(!ensurePromise){
    ensurePromise=(async()=>{
      await ensureHrV2();
      // A munkalap a foglalás, készlet és pénzügy közös tranzakciós magja,
      // ezért a hozzá tartozó additív workflow-sémát a pénzügyi bootstrap
      // előtt biztosítjuk. A művelet idempotens és nem töröl meglévő adatot.
      await ensureWorkOrderWorkflow(pool);
      for(const file of [
        '20260807_CASHIER_FINANCIAL_CLOSE_V1.sql',
        '20260807_FINANCE_OPERATIONS_V2.sql',
        '20260807_payroll_accounting_v2.sql',
        '20260807_FINANCE_INVOICES_V3.sql',
        '20260808_FINANCE_NAV_SCHEMA_REPAIR_V6.sql',
        '20260808_NAV_ONLINE_INVOICE_V4.sql',
        '20260808_NAV_ONLINE_INVOICE_V5_LIFECYCLE.sql',
      ]) await runSql(file);
      await ensureMenuHealth();
    })().catch(err=>{ensurePromise=null;throw err});
  }
  return ensurePromise;
}