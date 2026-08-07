BEGIN;

CREATE TABLE IF NOT EXISTS booking_communication_settings (
  location_id uuid PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
  confirmation_enabled boolean NOT NULL DEFAULT true,
  reminder_48h_enabled boolean NOT NULL DEFAULT true,
  reminder_24h_enabled boolean NOT NULL DEFAULT true,
  cancellation_enabled boolean NOT NULL DEFAULT true,
  waitlist_enabled boolean NOT NULL DEFAULT true,
  review_request_enabled boolean NOT NULL DEFAULT true,
  review_delay_hours integer NOT NULL DEFAULT 24,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO booking_communication_settings(location_id)
SELECT id FROM locations
ON CONFLICT(location_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS booking_communication_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid REFERENCES appointments(id) ON DELETE CASCADE,
  waitlist_id uuid REFERENCES booking_waitlist(id) ON DELETE CASCADE,
  location_id uuid REFERENCES locations(id) ON DELETE CASCADE,
  client_id uuid REFERENCES clients(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'email',
  event_type text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  body_text text NOT NULL,
  body_html text,
  scheduled_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  failed_at timestamptz,
  error_text text,
  attempt_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_communication_queue_channel_ck CHECK(channel IN ('email','sms','push')),
  CONSTRAINT booking_communication_queue_status_ck CHECK(status IN ('pending','processing','sent','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS booking_communication_queue_due_idx
ON booking_communication_queue(status,scheduled_at)
WHERE status='pending';

CREATE INDEX IF NOT EXISTS booking_communication_queue_appointment_idx
ON booking_communication_queue(appointment_id,event_type,scheduled_at);

CREATE UNIQUE INDEX IF NOT EXISTS booking_communication_unique_event_idx
ON booking_communication_queue(appointment_id,event_type,scheduled_at)
WHERE appointment_id IS NOT NULL AND status <> 'cancelled';

CREATE OR REPLACE FUNCTION queue_appointment_guest_communications()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_email text;
  v_name text;
  v_location text;
  v_employee text;
  v_cfg booking_communication_settings%ROWTYPE;
  v_when text;
BEGIN
  IF NEW.client_id IS NULL OR NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT email,COALESCE(full_name,name,'Vendég') INTO v_email,v_name FROM clients WHERE id=NEW.client_id;
  IF COALESCE(trim(v_email),'')='' THEN RETURN NEW; END IF;
  SELECT COALESCE(name,'Kleopátra Szalon') INTO v_location FROM locations WHERE id=NEW.location_id;
  SELECT COALESCE(full_name,name,'Szakember') INTO v_employee FROM employees WHERE id=NEW.employee_id;
  SELECT * INTO v_cfg FROM booking_communication_settings WHERE location_id=NEW.location_id;
  IF NOT FOUND THEN
    INSERT INTO booking_communication_settings(location_id) VALUES(NEW.location_id) ON CONFLICT DO NOTHING;
    SELECT * INTO v_cfg FROM booking_communication_settings WHERE location_id=NEW.location_id;
  END IF;
  v_when := to_char(NEW.start_time AT TIME ZONE 'Europe/Budapest','YYYY.MM.DD. HH24:MI');

  IF TG_OP='INSERT' THEN
    IF v_cfg.confirmation_enabled THEN
      INSERT INTO booking_communication_queue(appointment_id,location_id,client_id,event_type,recipient,subject,body_text,scheduled_at)
      VALUES(NEW.id,NEW.location_id,NEW.client_id,CASE WHEN NEW.status='confirmed' THEN 'booking_confirmed' ELSE 'booking_created' END,v_email,
        CASE WHEN NEW.status='confirmed' THEN 'Kleopátra Szalon – időpont visszaigazolva' ELSE 'Kleopátra Szalon – foglalási igény rögzítve' END,
        'Kedves '||v_name||E'!\n'||CASE WHEN NEW.status='confirmed' THEN 'Időpontját visszaigazoltuk.' ELSE 'Foglalási igényét rögzítettük.' END||E'\n'||v_location||E'\n'||v_when||E'\nSzakember: '||v_employee,now())
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND (OLD.start_time IS DISTINCT FROM NEW.start_time OR OLD.employee_id IS DISTINCT FROM NEW.employee_id) THEN
    UPDATE booking_communication_queue SET status='cancelled',updated_at=now()
      WHERE appointment_id=NEW.id AND status='pending' AND event_type IN ('reminder_48h','reminder_24h');
    IF v_cfg.confirmation_enabled THEN
      INSERT INTO booking_communication_queue(appointment_id,location_id,client_id,event_type,recipient,subject,body_text,scheduled_at)
      VALUES(NEW.id,NEW.location_id,NEW.client_id,'booking_rescheduled',v_email,'Kleopátra Szalon – időpont módosult',
        'Kedves '||v_name||E'!\nIdőpontja módosult.\nÚj időpont: '||v_location||', '||v_when||E'\nSzakember: '||v_employee,now())
      ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status='confirmed' AND v_cfg.confirmation_enabled THEN
      INSERT INTO booking_communication_queue(appointment_id,location_id,client_id,event_type,recipient,subject,body_text,scheduled_at)
      VALUES(NEW.id,NEW.location_id,NEW.client_id,'booking_confirmed',v_email,'Kleopátra Szalon – időpont visszaigazolva',
        'Kedves '||v_name||E'!\nIdőpontját visszaigazoltuk.\n'||v_location||E'\n'||v_when||E'\nSzakember: '||v_employee,now()) ON CONFLICT DO NOTHING;
    ELSIF NEW.status IN ('cancelled','canceled') AND v_cfg.cancellation_enabled THEN
      UPDATE booking_communication_queue SET status='cancelled',updated_at=now() WHERE appointment_id=NEW.id AND status='pending';
      INSERT INTO booking_communication_queue(appointment_id,location_id,client_id,event_type,recipient,subject,body_text,scheduled_at)
      VALUES(NEW.id,NEW.location_id,NEW.client_id,'booking_cancelled',v_email,'Kleopátra Szalon – időpont lemondva',
        'Kedves '||v_name||E'!\nA '||v_when||' időpontját lemondtuk.',now()) ON CONFLICT DO NOTHING;
    ELSIF NEW.status IN ('completed','paid') AND v_cfg.review_request_enabled THEN
      INSERT INTO booking_communication_queue(appointment_id,location_id,client_id,event_type,recipient,subject,body_text,scheduled_at)
      VALUES(NEW.id,NEW.location_id,NEW.client_id,'review_request',v_email,'Kleopátra Szalon – hogy érezte magát nálunk?',
        'Kedves '||v_name||E'!\nKöszönjük, hogy minket választott. Örömmel vesszük visszajelzését a látogatásáról.',now()+make_interval(hours=>v_cfg.review_delay_hours)) ON CONFLICT DO NOTHING;
    END IF;
  END IF;

  IF NEW.status NOT IN ('cancelled','canceled','no_show','completed','paid') THEN
    IF v_cfg.reminder_48h_enabled AND NEW.start_time-interval '48 hours'>now() THEN
      INSERT INTO booking_communication_queue(appointment_id,location_id,client_id,event_type,recipient,subject,body_text,scheduled_at)
      VALUES(NEW.id,NEW.location_id,NEW.client_id,'reminder_48h',v_email,'Kleopátra Szalon – emlékeztető az időpontjáról',
        'Kedves '||v_name||E'!\n48 óra múlva várjuk: '||v_location||', '||v_when||E'\nSzakember: '||v_employee,NEW.start_time-interval '48 hours') ON CONFLICT DO NOTHING;
    END IF;
    IF v_cfg.reminder_24h_enabled AND NEW.start_time-interval '24 hours'>now() THEN
      INSERT INTO booking_communication_queue(appointment_id,location_id,client_id,event_type,recipient,subject,body_text,scheduled_at)
      VALUES(NEW.id,NEW.location_id,NEW.client_id,'reminder_24h',v_email,'Kleopátra Szalon – holnap várjuk',
        'Kedves '||v_name||E'!\nHolnap várjuk: '||v_location||', '||v_when||E'\nSzakember: '||v_employee,NEW.start_time-interval '24 hours') ON CONFLICT DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_appointment_guest_communications ON appointments;
CREATE TRIGGER trg_appointment_guest_communications
AFTER INSERT OR UPDATE OF start_time,employee_id,status ON appointments
FOR EACH ROW EXECUTE FUNCTION queue_appointment_guest_communications();

COMMIT;
