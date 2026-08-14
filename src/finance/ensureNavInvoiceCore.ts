import {readFile} from 'fs/promises';
import path from 'path';
import pool from '../db';

let ensurePromise:Promise<void>|null=null;

type NavBootstrapState={
  ready:boolean;
  running:boolean;
  last_success_at:string|null;
  last_failure_at:string|null;
  stage:string|null;
  db_code:string|null;
  constraint:string|null;
  message:string|null;
};

const state:NavBootstrapState={
  ready:false,
  running:false,
  last_success_at:null,
  last_failure_at:null,
  stage:null,
  db_code:null,
  constraint:null,
  message:null
};

export class NavInvoiceBootstrapError extends Error{
  stage:string;
  dbCode:string|null;
  constraint:string|null;
  constructor(stage:string,cause:any){
    super(`NAV Online Számla bootstrap hiba [${stage}]: ${String(cause?.message||cause||'ismeretlen hiba')}`);
    this.name='NavInvoiceBootstrapError';
    this.stage=stage;
    this.dbCode=cause?.code?String(cause.code):null;
    this.constraint=cause?.constraint?String(cause.constraint):null;
    (this as any).cause=cause;
  }
}

async function step(stage:string,fn:()=>Promise<any>){
  try{return await fn()}
  catch(error:any){
    if(error instanceof NavInvoiceBootstrapError)throw error;
    throw new NavInvoiceBootstrapError(stage,error);
  }
}

async function runSql(file:string){
  const sql=await readFile(path.join(__dirname,'..','sql',file),'utf8');
  await pool.query(sql);
}

async function ensureAccountingBase(){
  // A NAV/számlázás ne függjön a bérszámfejtési bootstrap sikerétől.
  // A finance_invoices FK-ja miatt a két főkönyvi alaptábla már a NAV core előtt kell.
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE TABLE IF NOT EXISTS accounting_journal_entries(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
      entry_date date NOT NULL DEFAULT CURRENT_DATE,
      document_no text,
      source_type text,
      source_id text,
      description text,
      status text NOT NULL DEFAULT 'draft',
      created_by text,
      approved_by text,
      approved_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS accounting_journal_lines(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      journal_entry_id uuid REFERENCES accounting_journal_entries(id) ON DELETE CASCADE,
      account_code text,
      account_name text,
      debit numeric(14,2) NOT NULL DEFAULT 0,
      credit numeric(14,2) NOT NULL DEFAULT 0,
      employee_id uuid,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS accounting_journal_lines_journal_entry_idx
      ON accounting_journal_lines(journal_entry_id);
  `);
}

export function getNavInvoiceBootstrapState(){return {...state}}

/**
 * Kizárólag a NAV Online Számla + kimenő számla minimális adatbázis-magját
 * készíti elő. Szándékosan nem függ HR-, UAT-, cashier- vagy menü-bootstrapoktól,
 * így azok hibája nem blokkolhatja a NAV adatszolgáltatást.
 */
export function ensureNavInvoiceCore(){
  if(!ensurePromise){
    state.running=true;
    ensurePromise=(async()=>{
      await step('accounting_base',ensureAccountingBase);
      for(const file of [
        '20260807_FINANCE_OPERATIONS_V2.sql',
        '20260807_FINANCE_INVOICES_V3.sql',
        '20260808_FINANCE_NAV_SCHEMA_REPAIR_V6.sql',
        '20260808_NAV_ONLINE_INVOICE_V4.sql',
        '20260808_NAV_ONLINE_INVOICE_V5_LIFECYCLE.sql',
        '20260811_NAV_ONLINE_INVOICE_41A.sql',
        '20260811_NAV_ONLINE_INVOICE_41B_XSD.sql',
        '20260814_NAV_WORKORDER_GO_LIVE_V1.sql',
        '20260814_NAV_QUEUE_WORKER_V2.sql'
      ])await step(`sql:${file}`,()=>runSql(file));
      state.ready=true;
      state.last_success_at=new Date().toISOString();
      state.last_failure_at=null;
      state.stage=null;
      state.db_code=null;
      state.constraint=null;
      state.message=null;
    })().catch((error:any)=>{
      state.ready=false;
      state.last_failure_at=new Date().toISOString();
      state.stage=error?.stage?String(error.stage):null;
      state.db_code=error?.dbCode?String(error.dbCode):(error?.code?String(error.code):null);
      state.constraint=error?.constraint?String(error.constraint):null;
      state.message=String(error?.message||error);
      ensurePromise=null;
      throw error;
    }).finally(()=>{state.running=false});
  }
  return ensurePromise;
}
