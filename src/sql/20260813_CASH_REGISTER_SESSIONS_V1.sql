BEGIN;

CREATE TABLE IF NOT EXISTS cash_registers (
  id bigserial PRIMARY KEY,
  location_id text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT 'Főpénztár',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cash_register_sessions (
  id bigserial PRIMARY KEY,
  register_id bigint NOT NULL REFERENCES cash_registers(id),
  location_id text NOT NULL,
  business_date date NOT NULL,
  opening_cash numeric(14,2) NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'open',
  opened_by text,
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_by text,
  closed_at timestamptz,
  counted_cash numeric(14,2),
  expected_cash numeric(14,2),
  difference numeric(14,2),
  note text,
  CONSTRAINT cash_register_sessions_status_check CHECK (status IN ('open','closed')),
  UNIQUE (location_id, business_date)
);

CREATE INDEX IF NOT EXISTS cash_register_sessions_location_status_idx
  ON cash_register_sessions (location_id, status, business_date DESC);

CREATE TABLE IF NOT EXISTS cash_movements (
  id bigserial PRIMARY KEY,
  session_id bigint NOT NULL REFERENCES cash_register_sessions(id) ON DELETE RESTRICT,
  location_id text NOT NULL,
  direction varchar(10) NOT NULL,
  amount numeric(14,2) NOT NULL,
  reason text NOT NULL,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_movements_direction_check CHECK (direction IN ('in','out')),
  CONSTRAINT cash_movements_amount_check CHECK (amount > 0)
);

CREATE INDEX IF NOT EXISTS cash_movements_session_idx
  ON cash_movements (session_id, created_at DESC);

ALTER TABLE cash_register_closings
  ADD COLUMN IF NOT EXISTS session_id bigint,
  ADD COLUMN IF NOT EXISTS cash_in numeric(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cash_out numeric(14,2) NOT NULL DEFAULT 0;

COMMIT;
