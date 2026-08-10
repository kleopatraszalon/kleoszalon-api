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
}

export default repairBookingWorkOrderStatusConstraints;