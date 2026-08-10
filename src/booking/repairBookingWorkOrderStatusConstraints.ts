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
}

export default repairBookingWorkOrderStatusConstraints;
