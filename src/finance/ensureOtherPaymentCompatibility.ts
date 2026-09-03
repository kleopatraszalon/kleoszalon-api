import db from '../db';

let ready=false;
let pending:Promise<void>|null=null;

export async function ensureOtherPaymentCompatibility(){
  if(ready)return;
  if(pending)return pending;
  pending=(async()=>{
    await db.query(`
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      DO $repair$
      DECLARE
        v_att smallint;
        r record;
      BEGIN
        IF to_regclass('public.work_order_payments') IS NOT NULL THEN
          -- Some long-lived databases lost UUID/default metadata while keeping
          -- the canonical id column NOT NULL. Every payment writer omits id and
          -- therefore depends on this database-side default.
          IF EXISTS(
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public'
               AND table_name='work_order_payments'
               AND column_name='id'
               AND data_type='uuid'
               AND column_default IS NULL
          ) THEN
            ALTER TABLE work_order_payments ALTER COLUMN id SET DEFAULT gen_random_uuid();
          END IF;
          IF EXISTS(
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public'
               AND table_name='work_order_payments'
               AND column_name='paid_at'
               AND column_default IS NULL
          ) THEN
            ALTER TABLE work_order_payments ALTER COLUMN paid_at SET DEFAULT now();
          END IF;

          -- Legacy deployments accumulated implementation-only NOT NULL columns.
          -- The protected payment writer cannot populate columns it does not know,
          -- therefore keep only the canonical business columns mandatory.
          FOR r IN
            SELECT column_name
              FROM information_schema.columns
             WHERE table_schema='public'
               AND table_name='work_order_payments'
               AND is_nullable='NO'
               AND column_default IS NULL
               AND column_name NOT IN('id','work_order_id','payment_method','amount','paid_at')
          LOOP
            EXECUTE format('ALTER TABLE work_order_payments ALTER COLUMN %I DROP NOT NULL',r.column_name);
          END LOOP;

          SELECT attnum INTO v_att
            FROM pg_attribute
           WHERE attrelid='public.work_order_payments'::regclass
             AND attname='payment_method'
             AND NOT attisdropped;
          IF v_att IS NOT NULL THEN
            FOR r IN
              SELECT c.conname,lower(pg_get_constraintdef(c.oid)) definition
                FROM pg_constraint c
               WHERE c.conrelid='public.work_order_payments'::regclass
                 AND c.contype='c'
                 AND v_att=ANY(c.conkey)
            LOOP
              IF (
                   position('''cash''' in r.definition)>0
                OR position('''card''' in r.definition)>0
                OR position('''transfer''' in r.definition)>0
                OR position('''voucher''' in r.definition)>0
              ) AND position('''other''' in r.definition)=0 THEN
                EXECUTE format('ALTER TABLE work_order_payments DROP CONSTRAINT %I',r.conname);
              END IF;
            END LOOP;
            IF NOT EXISTS(
              SELECT 1 FROM pg_constraint
               WHERE conrelid='public.work_order_payments'::regclass
                 AND conname='work_order_payments_payment_method_ck'
            ) THEN
              ALTER TABLE work_order_payments
                ADD CONSTRAINT work_order_payments_payment_method_ck
                CHECK(payment_method IN('cash','card','transfer','voucher','other')) NOT VALID;
            END IF;
          END IF;
        END IF;

        IF to_regclass('public.financial_accounts') IS NOT NULL THEN
          IF EXISTS(
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public'
               AND table_name='financial_accounts'
               AND column_name='id'
               AND data_type='uuid'
               AND column_default IS NULL
          ) THEN
            ALTER TABLE financial_accounts ALTER COLUMN id SET DEFAULT gen_random_uuid();
          END IF;

          -- Preserve canonical mandatory account data but release obsolete
          -- legacy columns that otherwise block automatic account creation.
          FOR r IN
            SELECT column_name
              FROM information_schema.columns
             WHERE table_schema='public'
               AND table_name='financial_accounts'
               AND is_nullable='NO'
               AND column_default IS NULL
               AND column_name NOT IN('id','name','account_type')
          LOOP
            EXECUTE format('ALTER TABLE financial_accounts ALTER COLUMN %I DROP NOT NULL',r.column_name);
          END LOOP;

          SELECT attnum INTO v_att
            FROM pg_attribute
           WHERE attrelid='public.financial_accounts'::regclass
             AND attname='account_type'
             AND NOT attisdropped;
          IF v_att IS NOT NULL THEN
            FOR r IN
              SELECT c.conname,lower(pg_get_constraintdef(c.oid)) definition
                FROM pg_constraint c
               WHERE c.conrelid='public.financial_accounts'::regclass
                 AND c.contype='c'
                 AND v_att=ANY(c.conkey)
            LOOP
              IF (
                   position('''cash''' in r.definition)>0
                OR position('''bank''' in r.definition)>0
                OR position('''card''' in r.definition)>0
                OR position('''voucher''' in r.definition)>0
              ) AND position('''other''' in r.definition)=0 THEN
                EXECUTE format('ALTER TABLE financial_accounts DROP CONSTRAINT %I',r.conname);
              END IF;
            END LOOP;
            IF NOT EXISTS(
              SELECT 1 FROM pg_constraint
               WHERE conrelid='public.financial_accounts'::regclass
                 AND conname='financial_accounts_type_ck'
            ) THEN
              ALTER TABLE financial_accounts
                ADD CONSTRAINT financial_accounts_type_ck
                CHECK(account_type IN('cash','bank','card','online','voucher','other')) NOT VALID;
            END IF;
          END IF;
        END IF;

        IF to_regclass('public.financial_movements') IS NOT NULL THEN
          IF EXISTS(
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public'
               AND table_name='financial_movements'
               AND column_name='id'
               AND data_type='uuid'
               AND column_default IS NULL
          ) THEN
            ALTER TABLE financial_movements ALTER COLUMN id SET DEFAULT gen_random_uuid();
          END IF;

          -- Same compatibility rule for the audited ledger: only canonical
          -- identity/account/direction/amount fields stay mandatory.
          FOR r IN
            SELECT column_name
              FROM information_schema.columns
             WHERE table_schema='public'
               AND table_name='financial_movements'
               AND is_nullable='NO'
               AND column_default IS NULL
               AND column_name NOT IN('id','account_id','direction','amount')
          LOOP
            EXECUTE format('ALTER TABLE financial_movements ALTER COLUMN %I DROP NOT NULL',r.column_name);
          END LOOP;
        END IF;
      END
      $repair$;

      DO $seed$
      BEGIN
        IF to_regclass('public.finance_payment_methods') IS NOT NULL THEN
          INSERT INTO finance_payment_methods(location_id,code,name,method_type)
          VALUES(NULL,'other','Egyéb','custom')
          ON CONFLICT DO NOTHING;
        END IF;
      END
      $seed$;
    `);
    ready=true;
  })().catch(error=>{
    pending=null;
    throw error;
  });
  return pending;
}

export default ensureOtherPaymentCompatibility;
