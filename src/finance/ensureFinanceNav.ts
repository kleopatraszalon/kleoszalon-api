import {readFile} from 'fs/promises';
import path from 'path';
import pool,{PG_POOL_MAX} from '../db';
import {ensureHrV2} from '../hr/ensureHrV2';
import {ensureMenuHealth} from '../menu/ensureMenuHealth';
import {ensureFinanceV5Menu} from './ensureFinanceV5Menu';
import {ensureWorkOrderWorkflow} from '../workorders/ensureWorkOrderWorkflow';
import {ensureFixedAssetSchema} from '../routes/fixedAssets';

let ensurePromise:Promise<void>|null=null;
let bootstrapQueue:Promise<void>=Promise.resolve();
const RUNTIME_SCHEMA_LOCK_KEY='kleoszalon:runtime-schema-bootstrap:v1';

/**
 * Serializes lazy DDL bootstraps both inside one Node process and, when the pool
 * has a spare connection, across API instances through a PostgreSQL advisory
 * lock. This prevents cold-start deadlocks caused by independent modules taking
 * overlapping table locks in a different order.
 *
 * PG_POOL_MAX=1 falls back to the in-process queue so the dedicated advisory
 * lock connection cannot starve the callback's pool.query calls.
 */
export async function withRuntimeSchemaBootstrapLock<T>(fn:()=>Promise<T>):Promise<T>{
  let releaseQueue!:()=>void;
  const previous=bootstrapQueue;
  bootstrapQueue=new Promise<void>(resolve=>{releaseQueue=resolve});
  await previous;

  let client:any=null;
  const statementTimeout=Math.max(1000,Number(process.env.PG_STATEMENT_TIMEOUT_MS??8000));
  const lockTimeout=Math.max(statementTimeout,Number(process.env.PG_BOOTSTRAP_LOCK_TIMEOUT_MS??60000));
  try{
    if(PG_POOL_MAX>1){
      client=await pool.connect();
      await client.query(`SET statement_timeout = ${lockTimeout}`);
      await client.query(`SELECT pg_advisory_lock(hashtext($1)::bigint)`,[RUNTIME_SCHEMA_LOCK_KEY]);
    }
    return await fn();
  }finally{
    if(client){
      try{await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`,[RUNTIME_SCHEMA_LOCK_KEY])}catch(error){console.error('Runtime schema advisory unlock failed',error)}
      try{await client.query(`SET statement_timeout = ${statementTimeout}`)}catch{}
      client.release();
    }
    releaseQueue();
  }
}

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

async function ensureFinanceSupplierProjectionCompat(){
  const {rows}=await pool.query(`SELECT to_regclass('public.suppliers') AS relation_name`);
  if(!rows[0]?.relation_name)return;
  await pool.query(`
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS tax_number text;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS email text;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS phone text;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name text;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address text;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms_days integer NOT NULL DEFAULT 0;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS note text;
  `);
}

async function relationExists(name:string){
  const {rows}=await pool.query(`SELECT to_regclass($1) AS relation_name`,[`public.${name}`]);
  return Boolean(rows[0]?.relation_name);
}

async function ensureRbacBootstrapPrerequisites(){
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS access_roles (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_key text NOT NULL,
      name text NOT NULL,
      description text,
      level integer NOT NULL DEFAULT 10,
      is_system boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE access_roles ADD COLUMN IF NOT EXISTS description text;
    ALTER TABLE access_roles ADD COLUMN IF NOT EXISTS level integer NOT NULL DEFAULT 10;
    ALTER TABLE access_roles ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
    ALTER TABLE access_roles ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
    ALTER TABLE access_roles ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE access_roles ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS access_roles_key_uq ON access_roles(lower(role_key));

    CREATE TABLE IF NOT EXISTS role_menu_permissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      role_key text NOT NULL,
      menu_id bigint NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
      can_view boolean NOT NULL DEFAULT false,
      can_create boolean NOT NULL DEFAULT false,
      can_edit boolean NOT NULL DEFAULT false,
      can_delete boolean NOT NULL DEFAULT false,
      can_approve boolean NOT NULL DEFAULT false,
      can_export boolean NOT NULL DEFAULT false,
      can_view_financial boolean NOT NULL DEFAULT false,
      can_manage_permissions boolean NOT NULL DEFAULT false,
      scope_type text NOT NULL DEFAULT 'own_location',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(role_key,menu_id)
    );
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_view boolean NOT NULL DEFAULT false;
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_create boolean NOT NULL DEFAULT false;
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_edit boolean NOT NULL DEFAULT false;
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_delete boolean NOT NULL DEFAULT false;
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_approve boolean NOT NULL DEFAULT false;
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_export boolean NOT NULL DEFAULT false;
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_view_financial boolean NOT NULL DEFAULT false;
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS can_manage_permissions boolean NOT NULL DEFAULT false;
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'own_location';
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
    ALTER TABLE role_menu_permissions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS role_menu_permissions_role_menu_uq ON role_menu_permissions(role_key,menu_id);
    CREATE INDEX IF NOT EXISTS role_menu_permissions_lookup_idx ON role_menu_permissions(lower(role_key),menu_id,can_view);

    CREATE TABLE IF NOT EXISTS role_feature_permissions (
      role_key text NOT NULL,
      feature_key text NOT NULL,
      can_use boolean NOT NULL DEFAULT false,
      scope_type text NOT NULL DEFAULT 'own_location',
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(role_key,feature_key)
    );
    ALTER TABLE role_feature_permissions ADD COLUMN IF NOT EXISTS can_use boolean NOT NULL DEFAULT false;
    ALTER TABLE role_feature_permissions ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'own_location';
    ALTER TABLE role_feature_permissions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
    CREATE UNIQUE INDEX IF NOT EXISTS role_feature_permissions_role_feature_uq ON role_feature_permissions(role_key,feature_key);
  `);
}

export function ensureFinanceNav(){
  if(!ensurePromise){
    ensurePromise=withRuntimeSchemaBootstrapLock(async()=>{
      await step('work_order_workflow',()=>ensureWorkOrderWorkflow(pool));
      await step('hr_v2',()=>ensureHrV2());
      await step('fixed_assets_schema',()=>ensureFixedAssetSchema());
      await step('supplier_projection_compat',()=>ensureFinanceSupplierProjectionCompat());
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
      await step('rbac_core_schema',()=>ensureRbacBootstrapPrerequisites());
      await step('sql:20260810_RBAC_FAIL_CLOSED_V1.sql',()=>runSql('20260810_RBAC_FAIL_CLOSED_V1.sql'));
      if(await relationExists('users')){
        await step('sql:20260814_ACCOUNTING_USER_RBAC_V1.sql',()=>runSql('20260814_ACCOUNTING_USER_RBAC_V1.sql'));
      }else{
        console.warn('[Finance/NAV bootstrap] accounting user RBAC skipped: users relation is not present in this schema');
      }
      await step('sql:20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2.sql',()=>runSqlOnce(
        '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2.sql',
        '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V2'
      ));
      await step('sql:20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3.sql',()=>runSqlOnce(
        '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3.sql',
        '20260818_FIXED_ASSET_ACCOUNTING_GOVERNANCE_V3'
      ));
    }).catch(err=>{ensurePromise=null;throw err});
  }return ensurePromise;
}