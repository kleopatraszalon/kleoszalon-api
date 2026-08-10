BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS booking_voice_events(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  client_key_hash text NOT NULL,
  transcript text,
  transcript_length integer NOT NULL DEFAULT 0,
  intent text NOT NULL DEFAULT 'book',
  location_id uuid REFERENCES locations(id) ON DELETE SET NULL,
  service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
  requested_date date,
  requested_time time,
  preferred_period text,
  recognized boolean NOT NULL DEFAULT false,
  ai_used boolean NOT NULL DEFAULT false,
  missing_fields text[] NOT NULL DEFAULT '{}'::text[],
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS booking_voice_events_created_idx
  ON booking_voice_events(created_at DESC);
CREATE INDEX IF NOT EXISTS booking_voice_events_location_idx
  ON booking_voice_events(location_id,created_at DESC);
CREATE INDEX IF NOT EXISTS booking_voice_events_intent_idx
  ON booking_voice_events(intent,created_at DESC);
CREATE INDEX IF NOT EXISTS booking_voice_events_recognized_idx
  ON booking_voice_events(recognized,created_at DESC);

INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
VALUES('appointments','Időpontok és jelenlét','CalendarDays',NULL,20,NULL,'appointments',true)
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  icon=COALESCE(menus.icon,EXCLUDED.icon),
  is_active=true;

WITH p AS (SELECT id FROM menus WHERE code='appointments' LIMIT 1)
INSERT INTO menus(code,name,icon,route,order_index,parent_id,feature_key,is_active)
SELECT 'appointments.voice_stats','Voice Booking statisztika','ChartNoAxesCombined','/appointments/voice-booking-stats',35,p.id,'appointments',true
FROM p
ON CONFLICT(code) DO UPDATE SET
  name=EXCLUDED.name,
  icon=EXCLUDED.icon,
  route=EXCLUDED.route,
  order_index=EXCLUDED.order_index,
  parent_id=EXCLUDED.parent_id,
  feature_key=EXCLUDED.feature_key,
  is_active=true;

INSERT INTO role_menu_permissions(
  role_key,menu_id,can_view,can_create,can_edit,can_delete,can_approve,can_export,
  can_view_financial,can_manage_permissions,scope_type,updated_at
)
SELECT r.role_key,m.id,true,false,false,false,false,true,false,false,'all_locations',now()
FROM (VALUES('admin'),('manager')) r(role_key)
JOIN menus m ON m.code='appointments.voice_stats'
ON CONFLICT(role_key,menu_id) DO UPDATE SET
  can_view=true,
  can_create=false,
  can_edit=false,
  can_delete=false,
  can_approve=false,
  can_export=true,
  can_view_financial=false,
  can_manage_permissions=false,
  scope_type='all_locations',
  updated_at=now();

COMMIT;
