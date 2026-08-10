BEGIN;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS preferred_contact text DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS marketing_consent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS birth_date date,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE booking_communication_settings
  ADD COLUMN IF NOT EXISTS email_channel_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sms_channel_enabled boolean NOT NULL DEFAULT false;

DROP INDEX IF EXISTS booking_communication_unique_event_idx;
CREATE UNIQUE INDEX IF NOT EXISTS booking_communication_unique_event_channel_idx
ON booking_communication_queue(appointment_id,event_type,channel,scheduled_at)
WHERE appointment_id IS NOT NULL AND status <> 'cancelled';

CREATE TABLE IF NOT EXISTS customer_self_service_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
  action text NOT NULL,
  before_data jsonb,
  after_data jsonb,
  note text,
  actor_user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_self_service_log_client_idx
  ON customer_self_service_log(client_id,created_at DESC);
CREATE INDEX IF NOT EXISTS customer_self_service_log_appointment_idx
  ON customer_self_service_log(appointment_id,created_at DESC)
  WHERE appointment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION queue_booking_comm_event(
  p_appointment_id uuid,
  p_event_type text,
  p_scheduled_at timestamptz,
  p_subject text,
  p_body text
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_client_id uuid;
  v_location_id uuid;
  v_email text;
  v_phone text;
  v_preference text;
  v_email_enabled boolean;
  v_sms_enabled boolean;
  v_want_email boolean := false;
  v_want_sms boolean := false;
  v_count integer := 0;
BEGIN
  SELECT a.client_id,a.location_id,c.email,c.phone,lower(COALESCE(c.preferred_contact,'email')),
         COALESCE(s.email_channel_enabled,true),COALESCE(s.sms_channel_enabled,false)
    INTO v_client_id,v_location_id,v_email,v_phone,v_preference,v_email_enabled,v_sms_enabled
  FROM appointments a
  LEFT JOIN clients c ON c.id=a.client_id
  LEFT JOIN booking_communication_settings s ON s.location_id=a.location_id
  WHERE a.id=p_appointment_id;

  IF v_client_id IS NULL OR v_location_id IS NULL THEN RETURN 0; END IF;

  IF v_preference='both' THEN
    v_want_email := v_email_enabled AND COALESCE(trim(v_email),'')<>'';
    v_want_sms := v_sms_enabled AND COALESCE(trim(v_phone),'')<>'';
  ELSIF v_preference='sms' THEN
    v_want_sms := v_sms_enabled AND COALESCE(trim(v_phone),'')<>'';
  ELSE
    v_want_email := v_email_enabled AND COALESCE(trim(v_email),'')<>'';
  END IF;

  -- Ha a választott csatorna nem használható, ne vesszen el az értesítés.
  IF NOT v_want_email AND NOT v_want_sms THEN
    IF v_email_enabled AND COALESCE(trim(v_email),'')<>'' THEN
      v_want_email := true;
    ELSIF v_sms_enabled AND COALESCE(trim(v_phone),'')<>'' THEN
      v_want_sms := true;
    END IF;
  END IF;

  IF v_want_email THEN
    INSERT INTO booking_communication_queue(
      appointment_id,location_id,client_id,channel,event_type,recipient,subject,body_text,scheduled_at
    ) VALUES(
      p_appointment_id,v_location_id,v_client_id,'email',p_event_type,v_email,p_subject,p_body,p_scheduled_at
    ) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
  END IF;

  IF v_want_sms THEN
    INSERT INTO booking_communication_queue(
      appointment_id,location_id,client_id,channel,event_type,recipient,subject,body_text,scheduled_at
    ) VALUES(
      p_appointment_id,v_location_id,v_client_id,'sms',p_event_type,v_phone,p_subject,p_body,p_scheduled_at
    ) ON CONFLICT DO NOTHING;
    v_count := v_count + CASE WHEN FOUND THEN 1 ELSE 0 END;
  END IF;

  RETURN v_count;
END $$;

CREATE OR REPLACE FUNCTION queue_appointment_guest_communications()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_name text;
  v_location text;
  v_employee text;
  v_cfg booking_communication_settings%ROWTYPE;
  v_when text;
  v_body text;
BEGIN
  IF NEW.client_id IS NULL OR NEW.location_id IS NULL THEN RETURN NEW; END IF;
  SELECT COALESCE(full_name,name,'Vendég') INTO v_name FROM clients WHERE id=NEW.client_id;
  SELECT COALESCE(name,'Kleopátra Szalon') INTO v_location FROM locations WHERE id=NEW.location_id;
  SELECT COALESCE(full_name,name,'Szakember') INTO v_employee FROM employees WHERE id=NEW.employee_id;
  SELECT * INTO v_cfg FROM booking_communication_settings WHERE location_id=NEW.location_id;
  IF NOT FOUND THEN
    INSERT INTO booking_communication_settings(location_id) VALUES(NEW.location_id) ON CONFLICT DO NOTHING;
    SELECT * INTO v_cfg FROM booking_communication_settings WHERE location_id=NEW.location_id;
  END IF;
  v_when := to_char(NEW.start_time AT TIME ZONE 'Europe/Budapest','YYYY.MM.DD. HH24:MI');

  IF TG_OP='INSERT' AND v_cfg.confirmation_enabled THEN
    v_body := 'Kedves '||v_name||E'!\n'||CASE WHEN NEW.status='confirmed' THEN 'Időpontját visszaigazoltuk.' ELSE 'Foglalási igényét rögzítettük.' END||E'\n'||v_location||E'\n'||v_when||E'\nSzakember: '||v_employee;
    PERFORM queue_booking_comm_event(NEW.id,CASE WHEN NEW.status='confirmed' THEN 'booking_confirmed' ELSE 'booking_created' END,now(),CASE WHEN NEW.status='confirmed' THEN 'Kleopátra Szalon – időpont visszaigazolva' ELSE 'Kleopátra Szalon – foglalási igény rögzítve' END,v_body);
  END IF;

  IF TG_OP='UPDATE' AND (OLD.start_time IS DISTINCT FROM NEW.start_time OR OLD.employee_id IS DISTINCT FROM NEW.employee_id) THEN
    UPDATE booking_communication_queue SET status='cancelled',updated_at=now()
      WHERE appointment_id=NEW.id AND status='pending' AND event_type IN ('reminder_48h','reminder_24h');
    IF v_cfg.confirmation_enabled THEN
      v_body := 'Kedves '||v_name||E'!\nIdőpontja módosult.\nÚj időpont: '||v_location||', '||v_when||E'\nSzakember: '||v_employee;
      PERFORM queue_booking_comm_event(NEW.id,'booking_rescheduled',now(),'Kleopátra Szalon – időpont módosult',v_body);
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND OLD.status IS DISTINCT FROM NEW.status THEN
    IF NEW.status='confirmed' AND v_cfg.confirmation_enabled THEN
      v_body := 'Kedves '||v_name||E'!\nIdőpontját visszaigazoltuk.\n'||v_location||E'\n'||v_when||E'\nSzakember: '||v_employee;
      PERFORM queue_booking_comm_event(NEW.id,'booking_confirmed',now(),'Kleopátra Szalon – időpont visszaigazolva',v_body);
    ELSIF NEW.status IN ('cancelled','canceled') AND v_cfg.cancellation_enabled THEN
      UPDATE booking_communication_queue SET status='cancelled',updated_at=now()
        WHERE appointment_id=NEW.id AND status='pending';
      v_body := 'Kedves '||v_name||E'!\nA '||v_when||' időpontját lemondtuk.';
      PERFORM queue_booking_comm_event(NEW.id,'booking_cancelled',now(),'Kleopátra Szalon – időpont lemondva',v_body);
    ELSIF NEW.status IN ('completed','paid') AND v_cfg.review_request_enabled THEN
      v_body := 'Kedves '||v_name||E'!\nKöszönjük, hogy minket választott. Örömmel vesszük visszajelzését a látogatásáról.';
      PERFORM queue_booking_comm_event(NEW.id,'review_request',now()+make_interval(hours=>v_cfg.review_delay_hours),'Kleopátra Szalon – hogy érezte magát nálunk?',v_body);
    END IF;
  END IF;

  IF NEW.status NOT IN ('cancelled','canceled','no_show','completed','paid') THEN
    IF v_cfg.reminder_48h_enabled AND NEW.start_time-interval '48 hours'>now() THEN
      v_body := 'Kedves '||v_name||E'!\n48 óra múlva várjuk: '||v_location||', '||v_when||E'\nSzakember: '||v_employee||'.';
      PERFORM queue_booking_comm_event(NEW.id,'reminder_48h',NEW.start_time-interval '48 hours','Kleopátra Szalon – emlékeztető az időpontjáról',v_body);
    END IF;
    IF v_cfg.reminder_24h_enabled AND NEW.start_time-interval '24 hours'>now() THEN
      v_body := 'Kedves '||v_name||E'!\nHolnap várjuk: '||v_location||', '||v_when||E'\nSzakember: '||v_employee||'.';
      PERFORM queue_booking_comm_event(NEW.id,'reminder_24h',NEW.start_time-interval '24 hours','Kleopátra Szalon – holnap várjuk',v_body);
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_appointment_guest_communications ON appointments;
CREATE TRIGGER trg_appointment_guest_communications
AFTER INSERT OR UPDATE OF start_time,employee_id,status ON appointments
FOR EACH ROW EXECUTE FUNCTION queue_appointment_guest_communications();

COMMIT;
