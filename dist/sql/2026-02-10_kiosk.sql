-- 2026-02-10_kiosk.sql
-- Kiosk modul táblák (menü konfiguráció + sorszámos nyugta)

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS kiosk_menus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NULL,
  name text NOT NULL DEFAULT 'Kiosk menü',
  theme jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kiosk_menu_sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id uuid NOT NULL REFERENCES kiosk_menus(id) ON DELETE CASCADE,
  title_hu text NOT NULL,
  display_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS kiosk_menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  section_id uuid NOT NULL REFERENCES kiosk_menu_sections(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  display_order int NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  UNIQUE(section_id, service_id)
);

CREATE TABLE IF NOT EXISTS kiosk_ticket_counters (
  location_id uuid NOT NULL,
  yyyymmdd int NOT NULL,
  counter int NOT NULL DEFAULT 0,
  PRIMARY KEY(location_id, yyyymmdd)
);

CREATE TABLE IF NOT EXISTS kiosk_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  location_id uuid NOT NULL,
  ticket_no text NOT NULL,
  payment_method text NOT NULL, -- 'counter' | 'card'
  payment_status text NOT NULL DEFAULT 'pending', -- 'pending' | 'paid'
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kiosk_orders_location_created ON kiosk_orders(location_id, created_at DESC);
