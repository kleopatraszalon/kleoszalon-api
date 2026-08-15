-- VIR performance indexes v1
-- 2026-08-15
-- Cél: dashboard, naptár és időszakos aggregációk gyorsítása.
-- PostgreSQL: IF NOT EXISTS miatt idempotens.

CREATE INDEX IF NOT EXISTS idx_appointments_location_start_time
  ON public.appointments (location_id, start_time);

CREATE INDEX IF NOT EXISTS idx_appointments_location_status_start_time
  ON public.appointments (location_id, status, start_time);

CREATE INDEX IF NOT EXISTS idx_appointments_employee_start_time
  ON public.appointments (employee_id, start_time);

CREATE INDEX IF NOT EXISTS idx_appointments_start_time
  ON public.appointments (start_time);

CREATE INDEX IF NOT EXISTS idx_appointment_services_appointment_id
  ON public.appointment_services (appointment_id);

CREATE INDEX IF NOT EXISTS idx_appointment_services_service_appointment
  ON public.appointment_services (service_id, appointment_id);

ANALYZE public.appointments;
ANALYZE public.appointment_services;
