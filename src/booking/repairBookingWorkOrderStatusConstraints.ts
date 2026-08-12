import {repairLegacyWorkOrderTriggers} from '../workorders/repairLegacyWorkOrderTriggers';

let repairReady=false;
let repairPromise:Promise<void>|null=null;

const NON_FATAL_REPAIR_CODES=new Set([
  '57014', // statement timeout
  '55P03', // lock not available / lock timeout
  '42P01', // legacy table missing
  '42703', // legacy column missing
  '42710', // duplicate object
  '23505', // duplicate legacy data/index conflict
  '23514'  // legacy check constraint conflict
]);

async function optionalRepair(c:any,label:string,sql:string){
  try{
    await c.query(sql);
    return true;
  }catch(error:any){
    const code=String(error?.code||'');
    if(NON_FATAL_REPAIR_CODES.has(code)){
      console.warn(`[booking-workorder] ${label} skipped:`,code,error?.message||error);
      return false;
    }
    throw error;
  }
}

async function runBookingWorkOrderStatusRepair(c:any){

  await repairLegacyWorkOrderTriggers(c);

  // KRITIKUS legacy kompatibilitás: a régi work_order_items séma line_no mezője
  // NOT NULL. Ezt még minden egyéb, potenciálisan lockoló ALTER TABLE előtt
  // biztosítjuk, hogy egy későbbi statement timeout ne blokkolja a munkalap tételeit.
  await c.query(`
    CREATE OR REPLACE FUNCTION fill_work_order_item_line_no()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $line$
    BEGIN
      IF NEW.line_no IS NULL THEN
        PERFORM pg_advisory_xact_lock(hashtext('work-order-lines:' || COALESCE(NEW.work_order_id::text,'')));
        SELECT COALESCE(MAX(line_no),0)+1
          INTO NEW.line_no
          FROM work_order_items
         WHERE work_order_id=NEW.work_order_id;
      END IF;
      RETURN NEW;
    END
    $line$;
  `);

  await c.query(`
    DO $$
    BEGIN
      IF to_regclass('public.work_order_items') IS NOT NULL
         AND EXISTS(
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='work_order_items' AND column_name='line_no'
         )
         AND NOT EXISTS(
           SELECT 1
             FROM pg_trigger
            WHERE tgname='trg_fill_work_order_item_line_no'
              AND tgrelid='public.work_order_items'::regclass
              AND NOT tgisinternal
         ) THEN
        CREATE TRIGGER trg_fill_work_order_item_line_no
          BEFORE INSERT ON work_order_items
          FOR EACH ROW EXECUTE FUNCTION fill_work_order_item_line_no();
      END IF;
    END $$;
  `);

  // Legacy compatibility: a régi séma order_number, az új workflow
  // work_order_number néven tárolja ugyanazt a hivatalos munkalapszámot.
  await optionalRepair(c,'work order number compatibility',`
    DO $$
    BEGIN
      IF to_regclass('public.work_orders') IS NOT NULL
         AND EXISTS(
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='work_orders' AND column_name='order_number'
         )
         AND EXISTS(
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='work_orders' AND column_name='work_order_number'
         ) THEN

        UPDATE work_orders
           SET work_order_number=order_number
         WHERE work_order_number IS NULL AND order_number IS NOT NULL;

        UPDATE work_orders
           SET order_number=work_order_number
         WHERE order_number IS NULL AND work_order_number IS NOT NULL;

        CREATE OR REPLACE FUNCTION sync_work_order_number_columns()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $sync$
        BEGIN
          IF TG_OP='INSERT' THEN
            IF NEW.work_order_number IS NOT NULL THEN
              NEW.order_number:=NEW.work_order_number;
            ELSIF NEW.order_number IS NOT NULL THEN
              NEW.work_order_number:=NEW.order_number;
            END IF;
          ELSE
            IF NEW.work_order_number IS DISTINCT FROM OLD.work_order_number
               AND NEW.work_order_number IS NOT NULL THEN
              NEW.order_number:=NEW.work_order_number;
            ELSIF NEW.order_number IS DISTINCT FROM OLD.order_number
               AND NEW.order_number IS NOT NULL THEN
              NEW.work_order_number:=NEW.order_number;
            ELSIF NEW.work_order_number IS NULL AND NEW.order_number IS NOT NULL THEN
              NEW.work_order_number:=NEW.order_number;
            ELSIF NEW.order_number IS NULL AND NEW.work_order_number IS NOT NULL THEN
              NEW.order_number:=NEW.work_order_number;
            END IF;
          END IF;
          RETURN NEW;
        END
        $sync$;

        IF NOT EXISTS(
          SELECT 1
            FROM pg_trigger
           WHERE tgname='trg_sync_work_order_number_columns'
             AND tgrelid='public.work_orders'::regclass
             AND NOT tgisinternal
        ) THEN
          CREATE TRIGGER trg_sync_work_order_number_columns
            BEFORE INSERT OR UPDATE OF order_number,work_order_number ON work_orders
            FOR EACH ROW EXECUTE FUNCTION sync_work_order_number_columns();
        END IF;
      END IF;
    END $$;
  `);

  // A live work_orders / work_order_items táblák több régi generációból maradtak össze.
  // A modern modellben ezek a hivatkozási és megjelenítési mezők opcionálisak.
  await optionalRepair(c,'legacy nullable columns',`
    DO $$
    DECLARE col text;
    BEGIN
      IF to_regclass('public.work_orders') IS NOT NULL THEN
        FOREACH col IN ARRAY ARRAY[
          'title','notes','employee_id','client_id','client_name','client_phone','client_email',
          'location_id','appointment_id','created_by','work_order_number','source_created_at','source_snapshot',
          'locked_at','locked_reason','archived_at','archive_hash',
          'visit_status','record_note','client_first_name','client_last_name','total_price',
          'gross_total','discount_amount','tip_amount','amount_due','amount_paid','payment_status','invoice_status','document_status'
        ] LOOP
          IF EXISTS(
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='work_orders' AND column_name=col
          ) THEN
            EXECUTE format('ALTER TABLE work_orders ALTER COLUMN %I DROP NOT NULL',col);
          END IF;
        END LOOP;
      END IF;

      IF to_regclass('public.work_order_items') IS NOT NULL THEN
        FOREACH col IN ARRAY ARRAY['service_id','product_id','item_name','duration_minutes'] LOOP
          IF EXISTS(
            SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='work_order_items' AND column_name=col
          ) THEN
            EXECUTE format('ALTER TABLE work_order_items ALTER COLUMN %I DROP NOT NULL',col);
          END IF;
        END LOOP;
      END IF;
    END $$;
  `);

  // A státusz checkek javítása lehet lock-érzékeny egy élő adatbázison.
  // Ha timeoutot kap, az üzleti request ettől még folytatódhat; következő deploynál
  // újra megpróbálható, miközben a kritikus line_no kompatibilitás már aktív.
  await optionalRepair(c,'appointments status constraint',`
    DO $$
    DECLARE status_att smallint; r record;
    BEGIN
      SELECT attnum INTO status_att FROM pg_attribute WHERE attrelid='appointments'::regclass AND attname='status' AND NOT attisdropped;
      IF status_att IS NOT NULL THEN
        FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='appointments'::regclass AND contype='c' AND status_att = ANY(conkey)
        LOOP EXECUTE format('ALTER TABLE appointments DROP CONSTRAINT %I',r.conname); END LOOP;
      END IF;
      ALTER TABLE appointments ADD CONSTRAINT chk_appointments_status_phase3
        CHECK(status IN('waiting','pending','booked','confirmed','arrived','in_progress','completed','paid','cancelled','canceled','no_show','rescheduled')) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await optionalRepair(c,'work orders status constraint',`
    DO $$
    DECLARE status_att smallint; r record;
    BEGIN
      SELECT attnum INTO status_att FROM pg_attribute WHERE attrelid='work_orders'::regclass AND attname='status' AND NOT attisdropped;
      IF status_att IS NOT NULL THEN
        FOR r IN SELECT conname FROM pg_constraint WHERE conrelid='work_orders'::regclass AND contype='c' AND status_att = ANY(conkey)
        LOOP EXECUTE format('ALTER TABLE work_orders DROP CONSTRAINT %I',r.conname); END LOOP;
      END IF;
      ALTER TABLE work_orders ADD CONSTRAINT chk_work_orders_operational_status
        CHECK(status IN('waiting','arrived','in_progress','completed','cancelled','canceled','no_show','draft','open','paid')) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // A dokumentum státusz külön életciklus. Régi adatbázisokban több eltérő CHECK
  // maradt fenn; ezek az in_progress -> document_status='open' váltást 500-zal
  // megakaszthatják. A live értékeket normalizáljuk és egységes CHECK-et adunk.
  await optionalRepair(c,'work orders document status constraint',`
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS document_status text;
    UPDATE work_orders
       SET document_status=CASE
         WHEN status='completed' THEN 'completed'
         WHEN status IN('cancelled','canceled','no_show') THEN 'cancelled'
         WHEN status='in_progress' THEN 'open'
         ELSE 'draft'
       END
     WHERE document_status IS NULL
        OR document_status NOT IN('draft','open','completed','cancelled');
    ALTER TABLE work_orders ALTER COLUMN document_status SET DEFAULT 'draft';
    DO $$
    DECLARE status_att smallint; r record;
    BEGIN
      SELECT attnum INTO status_att
        FROM pg_attribute
       WHERE attrelid='work_orders'::regclass
         AND attname='document_status'
         AND NOT attisdropped;
      IF status_att IS NOT NULL THEN
        FOR r IN
          SELECT conname
            FROM pg_constraint
           WHERE conrelid='work_orders'::regclass
             AND contype='c'
             AND status_att=ANY(conkey)
        LOOP
          EXECUTE format('ALTER TABLE work_orders DROP CONSTRAINT %I',r.conname);
        END LOOP;
      END IF;
      ALTER TABLE work_orders ADD CONSTRAINT work_orders_document_status_chk
        CHECK(document_status IN('draft','open','completed','cancelled')) NOT VALID;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  // Pénzügyi runtime kompatibilitás. A live work_orders és work_order_payments
  // több séma-generáció mezőit tartalmazhatja; az új pénztári folyamat csak a
  // kanonikus mezőkre támaszkodik. Régi extra NOT NULL oszlopok ezért nem
  // blokkolhatják a fizetési sorok rögzítését.
  await optionalRepair(c,'work order financial runtime schema',`
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS gross_total numeric(14,2) DEFAULT 0;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS discount_amount numeric(14,2) DEFAULT 0;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS tip_amount numeric(14,2) DEFAULT 0;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS amount_due numeric(14,2) DEFAULT 0;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS amount_paid numeric(14,2) DEFAULT 0;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS payment_status text DEFAULT 'unpaid';
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS invoice_status text DEFAULT 'not_requested';
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS fully_paid boolean DEFAULT false;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS financial_closed_at timestamptz;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS financial_closed_by text;
    ALTER TABLE work_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

    DO $$
    BEGIN
      IF EXISTS(
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='work_orders'
           AND column_name='financial_closed_by' AND data_type<>'text'
      ) THEN
        ALTER TABLE work_orders ALTER COLUMN financial_closed_by TYPE text USING financial_closed_by::text;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS work_order_payments(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      work_order_id uuid NOT NULL REFERENCES work_orders(id),
      payment_method text NOT NULL,
      amount numeric(14,2) NOT NULL,
      paid_at timestamptz NOT NULL DEFAULT now(),
      note text,
      financial_account_id uuid,
      financial_movement_id uuid
    );
    ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS payment_method text;
    ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS amount numeric(14,2);
    ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS paid_at timestamptz DEFAULT now();
    ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS note text;
    ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS financial_account_id uuid;
    ALTER TABLE work_order_payments ADD COLUMN IF NOT EXISTS financial_movement_id uuid;
    ALTER TABLE work_order_payments ALTER COLUMN paid_at SET DEFAULT now();

    DO $$
    DECLARE r record;
    BEGIN
      IF to_regclass('public.work_order_payments') IS NOT NULL THEN
        IF EXISTS(
          SELECT 1 FROM information_schema.columns
           WHERE table_schema='public' AND table_name='work_order_payments'
             AND column_name='id' AND data_type='uuid'
        ) THEN
          ALTER TABLE work_order_payments ALTER COLUMN id SET DEFAULT gen_random_uuid();
        END IF;

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
      END IF;
    END $$;
  `);

  // Egy process élettartama alatt ne futtassuk újra minden HTTP kérésnél a DDL-t.
  repairReady=true;
}

export async function repairBookingWorkOrderStatusConstraints(c:any){
  if(repairReady)return;
  if(repairPromise)return repairPromise;
  repairPromise=(async()=>{
    const ready=(await c.query(`SELECT
      EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_fill_work_order_item_line_no' AND NOT tgisinternal)
      AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='work_orders' AND column_name='document_status')
      AND to_regclass('public.work_order_payments') IS NOT NULL ok`)).rows[0]?.ok;
    if(ready){repairReady=true;return}
    await runBookingWorkOrderStatusRepair(c);
  })().catch(error=>{repairPromise=null;throw error});
  return repairPromise;
}

export default repairBookingWorkOrderStatusConstraints;
