import pool from "../db";

export async function ensureOnlineBooking() {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    ALTER TABLE appointments
      ADD COLUMN IF NOT EXISTS booking_source text NOT NULL DEFAULT 'internal',
      ADD COLUMN IF NOT EXISTS cancellation_reason text,
      ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
      ADD COLUMN IF NOT EXISTS cancellation_token uuid,
      ADD COLUMN IF NOT EXISTS recurring_group_id uuid,
      ADD COLUMN IF NOT EXISTS confirmation_required boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
      ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

    CREATE UNIQUE INDEX IF NOT EXISTS appointments_cancellation_token_uq
      ON appointments(cancellation_token)
      WHERE cancellation_token IS NOT NULL;

    CREATE INDEX IF NOT EXISTS appointments_employee_time_idx
      ON appointments(employee_id,start_time,end_time)
      WHERE status NOT IN ('cancelled','canceled','no_show');

    CREATE TABLE IF NOT EXISTS employee_service_overrides (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      custom_price numeric(12,2),
      custom_duration_minutes integer,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS employee_service_override_unique
      ON employee_service_overrides(employee_id,service_id);

    CREATE TABLE IF NOT EXISTS appointment_services (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      service_id uuid NOT NULL REFERENCES services(id),
      duration_minutes integer NOT NULL DEFAULT 30,
      price numeric(12,2) NOT NULL DEFAULT 0,
      discount_percent numeric(5,2) NOT NULL DEFAULT 0,
      sort_order integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS appointment_services_appointment_idx
      ON appointment_services(appointment_id);

    CREATE TABLE IF NOT EXISTS appointment_change_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
      action text NOT NULL,
      actor_key text,
      before_data jsonb,
      after_data jsonb,
      note text,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS appointment_change_log_appointment_idx
      ON appointment_change_log(appointment_id,created_at DESC);

    CREATE TABLE IF NOT EXISTS appointment_technical_breaks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
      start_time timestamptz NOT NULL,
      end_time timestamptz NOT NULL,
      title text NOT NULL DEFAULT 'Technikai szünet',
      note text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK (end_time > start_time)
    );

    CREATE INDEX IF NOT EXISTS appointment_technical_breaks_employee_time_idx
      ON appointment_technical_breaks(employee_id,start_time,end_time);

    CREATE TABLE IF NOT EXISTS booking_waitlist (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
      client_name text NOT NULL,
      phone text,
      email text,
      service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
      preferred_employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
      preferred_from timestamptz,
      preferred_to timestamptz,
      note text,
      status text NOT NULL DEFAULT 'waiting',
      source text NOT NULL DEFAULT 'internal',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS booking_waitlist_status_idx
      ON booking_waitlist(location_id,status,created_at);

    CREATE TABLE IF NOT EXISTS online_booking_settings (
      location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
      enabled boolean NOT NULL DEFAULT true,
      online_discount_percent numeric(5,2) NOT NULL DEFAULT 5,
      slot_interval_minutes integer NOT NULL DEFAULT 15,
      opening_minute integer NOT NULL DEFAULT 480,
      closing_minute integer NOT NULL DEFAULT 1200,
      booking_horizon_days integer NOT NULL DEFAULT 60,
      minimum_notice_minutes integer NOT NULL DEFAULT 60,
      require_staff_confirmation boolean NOT NULL DEFAULT true,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    INSERT INTO online_booking_settings(location_id)
    SELECT id FROM locations
    ON CONFLICT(location_id) DO NOTHING
  `);
}

export default ensureOnlineBooking;
