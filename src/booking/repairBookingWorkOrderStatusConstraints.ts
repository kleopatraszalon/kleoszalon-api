export async function repairBookingWorkOrderStatusConstraints(c:any){
  await c.query(`
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

  await c.query(`
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

  // A live work_orders / work_order_items táblák több régi generációból maradtak össze.
  // A modern modellben ezek a hivatkozási és megjelenítési mezők opcionálisak,
  // ezért egy törölt régi dolgozó/szolgáltatás nem akadályozhatja meg a munkalap létrehozását.
  await c.query(`
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

  // Legacy compatibility: a régi séma order_number, az új workflow work_order_number
  // néven tárolja ugyanazt a hivatalos munkalapszámot. Ha mindkét oszlop létezik,
  // a meglévő adatokat visszatöltjük és BEFORE triggerrel kétirányúan szinkronban tartjuk.
  // Így a legacy order_number NOT NULL feltétel is teljesül új munkalap beszúrásakor.
  await c.query(`
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

        DROP TRIGGER IF EXISTS trg_sync_work_order_number_columns ON work_orders;
        CREATE TRIGGER trg_sync_work_order_number_columns
          BEFORE INSERT OR UPDATE OF order_number,work_order_number ON work_orders
          FOR EACH ROW EXECUTE FUNCTION sync_work_order_number_columns();
      END IF;
    END $$;
  `);

  // A legacy work_order_items séma kötelező line_no mezőt használ. Az új workflow
  // a tételeket sorrendben hozza létre, ezért BEFORE INSERT triggerrel munkalaponként
  // 1..N sorszámot adunk. Az advisory lock megakadályozza a párhuzamos sorszámütközést.
  await c.query(`
    DO $$
    BEGIN
      IF to_regclass('public.work_order_items') IS NOT NULL
         AND EXISTS(
           SELECT 1 FROM information_schema.columns
            WHERE table_schema='public' AND table_name='work_order_items' AND column_name='line_no'
         ) THEN
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

        DROP TRIGGER IF EXISTS trg_fill_work_order_item_line_no ON work_order_items;
        CREATE TRIGGER trg_fill_work_order_item_line_no
          BEFORE INSERT ON work_order_items
          FOR EACH ROW EXECUTE FUNCTION fill_work_order_item_line_no();
      END IF;
    END $$;
  `);
}

export default repairBookingWorkOrderStatusConstraints;