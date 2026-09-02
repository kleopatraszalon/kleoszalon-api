import db from '../db';

let ready=false;
let pending:Promise<void>|null=null;

export async function ensureOtherPaymentCompatibility(){
  if(ready)return;
  if(pending)return pending;
  pending=(async()=>{
    await db.query(`
      DO $repair$
      DECLARE
        v_att smallint;
        r record;
      BEGIN
        IF to_regclass('public.work_order_payments') IS NOT NULL THEN
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
