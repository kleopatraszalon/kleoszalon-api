import { Router } from "express";
import crypto from "crypto";
import db from "../db";
import { AuthRequest } from "../middleware/auth";
import { ensureBookingWorkOrder, ensureBookingWorkOrderSchema } from "../services/bookingWorkOrder";
import { queueAppointmentCommunications } from "../booking/communications";
import { sendEmail } from "../mailer";
import { sendSms } from "../sms";

const router = Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WAITLIST_STATUSES = new Set(["waiting", "contacted", "booked", "cancelled"]);
const OFFER_STATUSES = new Set(["pending", "accepted", "declined", "expired", "cancelled"]);
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const actor = (req: AuthRequest) => req.user?.email || String(req.user?.id || "unknown");

async function ensureSmartWaitlistSchema(cx: any = db) {
  await cx.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    ALTER TABLE booking_waitlist
      ADD COLUMN IF NOT EXISTS priority_level smallint NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS accept_short_notice boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS auto_offer boolean NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS last_offered_at timestamptz,
      ADD COLUMN IF NOT EXISTS offer_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS booked_appointment_id uuid,
      ADD COLUMN IF NOT EXISTS smart_note text;

    CREATE INDEX IF NOT EXISTS booking_waitlist_smart_match_idx
      ON booking_waitlist(location_id,status,preferred_employee_id,preferred_from,preferred_to,created_at);

    CREATE TABLE IF NOT EXISTS smart_waitlist_vacancies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL,
      location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      employee_id uuid REFERENCES employees(id) ON DELETE SET NULL,
      start_time timestamptz NOT NULL,
      end_time timestamptz NOT NULL,
      service_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
      status text NOT NULL DEFAULT 'open',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      filled_at timestamptz,
      CHECK(end_time > start_time),
      CHECK(status IN ('open','offered','filled','expired','cancelled'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS smart_waitlist_vacancy_source_uq
      ON smart_waitlist_vacancies(source_appointment_id)
      WHERE source_appointment_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS smart_waitlist_vacancy_open_idx
      ON smart_waitlist_vacancies(location_id,status,start_time);

    CREATE TABLE IF NOT EXISTS smart_waitlist_offers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      vacancy_id uuid NOT NULL REFERENCES smart_waitlist_vacancies(id) ON DELETE CASCADE,
      waitlist_id uuid NOT NULL REFERENCES booking_waitlist(id) ON DELETE CASCADE,
      score integer NOT NULL DEFAULT 0,
      score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
      token uuid NOT NULL DEFAULT gen_random_uuid(),
      status text NOT NULL DEFAULT 'pending',
      expires_at timestamptz NOT NULL,
      offered_at timestamptz NOT NULL DEFAULT now(),
      responded_at timestamptz,
      notification_channel text,
      notification_status text,
      notification_error text,
      created_by text,
      booked_appointment_id uuid,
      CHECK(status IN ('pending','accepted','declined','expired','cancelled'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS smart_waitlist_offer_token_uq ON smart_waitlist_offers(token);
    CREATE UNIQUE INDEX IF NOT EXISTS smart_waitlist_offer_pair_uq ON smart_waitlist_offers(vacancy_id,waitlist_id);
    CREATE INDEX IF NOT EXISTS smart_waitlist_offer_pending_idx ON smart_waitlist_offers(vacancy_id,status,expires_at);

    CREATE OR REPLACE FUNCTION kleo_capture_smart_waitlist_vacancy()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE ids uuid[];
    BEGIN
      IF lower(COALESCE(OLD.status,'')) NOT IN ('cancelled','canceled')
         AND lower(COALESCE(NEW.status,'')) IN ('cancelled','canceled') THEN
        SELECT COALESCE(array_agg(service_id ORDER BY sort_order),'{}'::uuid[])
          INTO ids FROM appointment_services WHERE appointment_id=NEW.id;
        INSERT INTO smart_waitlist_vacancies(
          source_appointment_id,location_id,employee_id,start_time,end_time,service_ids,status
        ) VALUES(
          NEW.id,NEW.location_id,NEW.employee_id,NEW.start_time,NEW.end_time,COALESCE(ids,'{}'::uuid[]),
          CASE WHEN NEW.end_time <= now() THEN 'expired' ELSE 'open' END
        )
        ON CONFLICT(source_appointment_id) WHERE source_appointment_id IS NOT NULL
        DO UPDATE SET
          location_id=EXCLUDED.location_id,
          employee_id=EXCLUDED.employee_id,
          start_time=EXCLUDED.start_time,
          end_time=EXCLUDED.end_time,
          service_ids=EXCLUDED.service_ids,
          status=CASE WHEN EXCLUDED.end_time <= now() THEN 'expired' ELSE 'open' END,
          updated_at=now();
      END IF;
      RETURN NEW;
    END $$;

    DROP TRIGGER IF EXISTS trg_capture_smart_waitlist_vacancy ON appointments;
    CREATE TRIGGER trg_capture_smart_waitlist_vacancy
      AFTER UPDATE OF status ON appointments
      FOR EACH ROW EXECUTE FUNCTION kleo_capture_smart_waitlist_vacancy();
  `);
}

async function expireStale(cx: any = db) {
  await cx.query(`UPDATE smart_waitlist_offers
    SET status='expired',responded_at=now()
    WHERE status='pending' AND expires_at<=now()`);
  await cx.query(`UPDATE smart_waitlist_vacancies
    SET status='expired',updated_at=now()
    WHERE status IN ('open','offered') AND end_time<=now()`);
  await cx.query(`UPDATE booking_waitlist w
    SET status='waiting',updated_at=now()
    WHERE w.status='contacted'
      AND NOT EXISTS (
        SELECT 1 FROM smart_waitlist_offers o
        WHERE o.waitlist_id=w.id AND o.status='pending' AND o.expires_at>now()
      )
      AND w.booked_appointment_id IS NULL`);
}

async function getVacancy(vacancyId: string, cx: any = db, lock = false) {
  if (!UUID_RE.test(vacancyId)) return null;
  const suffix = lock ? " FOR UPDATE" : "";
  const { rows } = await cx.query(`SELECT v.*,
      COALESCE(e.full_name,e.name,'') employee_name,
      COALESCE(l.name,'') location_name,
      EXTRACT(EPOCH FROM (v.end_time-v.start_time))/60 duration_minutes
    FROM smart_waitlist_vacancies v
    LEFT JOIN employees e ON e.id=v.employee_id
    LEFT JOIN locations l ON l.id=v.location_id
    WHERE v.id=$1::uuid LIMIT 1${suffix}`, [vacancyId]);
  return rows[0] || null;
}

async function candidateRows(vacancyId: string, cx: any = db) {
  const vacancy = await getVacancy(vacancyId, cx, false);
  if (!vacancy || !["open", "offered"].includes(String(vacancy.status))) return { vacancy, candidates: [] as any[] };

  const { rows } = await cx.query(`
    SELECT w.*,
      COALESCE(sr.duration_minutes,0)::int requested_duration_minutes,
      COALESCE(sr.service_names,'') service_names
    FROM booking_waitlist w
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(s.duration_minutes,30)),0)::int duration_minutes,
             string_agg(s.name, ', ' ORDER BY s.name) service_names
      FROM services s WHERE s.id=ANY(w.service_ids)
    ) sr ON true
    WHERE w.location_id=$1::uuid
      AND w.status='waiting'
      AND cardinality(w.service_ids)>0
      AND w.service_ids <@ $2::uuid[]
      AND (w.preferred_employee_id IS NULL OR w.preferred_employee_id=$3::uuid)
      AND (w.preferred_from IS NULL OR w.preferred_from<=$4::timestamptz)
      AND (w.preferred_to IS NULL OR w.preferred_to>=$5::timestamptz)
      AND COALESCE(sr.duration_minutes,0) <= $6::numeric
      AND (w.accept_short_notice=true OR $4::timestamptz >= now()+interval '24 hours')
    ORDER BY w.created_at ASC`, [
      vacancy.location_id,
      vacancy.service_ids || [],
      vacancy.employee_id,
      vacancy.start_time,
      vacancy.end_time,
      Number(vacancy.duration_minutes || 0),
    ]);

  const startMs = new Date(vacancy.start_time).getTime();
  const shortNotice = startMs - Date.now() < 24 * 3600_000;
  const vacancyServices = (vacancy.service_ids || []).map(String).sort();

  const candidates = rows.map((w: any) => {
    const exactEmployee = Boolean(w.preferred_employee_id) && String(w.preferred_employee_id) === String(vacancy.employee_id);
    const employee = exactEmployee ? 30 : 20;
    const hasFrom = Boolean(w.preferred_from), hasTo = Boolean(w.preferred_to);
    const time = hasFrom && hasTo ? 25 : (hasFrom || hasTo ? 20 : 15);
    const waitingDays = Math.max(0, (Date.now() - new Date(w.created_at).getTime()) / 86400_000);
    const age = Math.min(15, Math.floor(waitingDays));
    const priority = clamp(Number(w.priority_level || 0), 0, 5) * 3;
    const notice = shortNotice && w.accept_short_notice ? 10 : 0;
    const requested = (w.service_ids || []).map(String).sort();
    const exactService = requested.length === vacancyServices.length && requested.every((x: string, i: number) => x === vacancyServices[i]);
    const service = exactService ? 5 : 0;
    const score = clamp(employee + time + age + priority + notice + service, 0, 100);
    return {
      ...w,
      score,
      score_breakdown: { employee, time, waiting_age: age, priority, short_notice: notice, exact_service: service },
    };
  }).sort((a: any, b: any) => b.score - a.score || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  return { vacancy, candidates };
}

async function detectComplexSource(cx: any, sourceAppointmentId: string | null) {
  if (!sourceAppointmentId) return false;
  const tables = await cx.query(`SELECT
    to_regclass('public.appointment_staff_assignments') IS NOT NULL staff_ok,
    to_regclass('public.appointment_resource_allocations') IS NOT NULL resource_ok`);
  const flags = tables.rows[0] || {};
  if (flags.resource_ok) {
    const resource = await cx.query(`SELECT 1 FROM appointment_resource_allocations WHERE appointment_id=$1::uuid LIMIT 1`, [sourceAppointmentId]);
    if (resource.rowCount) return true;
  }
  if (flags.staff_ok) {
    const staff = await cx.query(`SELECT COUNT(DISTINCT employee_id)::int n FROM appointment_staff_assignments WHERE appointment_id=$1::uuid`, [sourceAppointmentId]);
    if (Number(staff.rows[0]?.n || 0) > 1) return true;
  }
  return false;
}

router.use(async (_req, _res, next) => {
  try { await ensureSmartWaitlistSchema(); await expireStale(); next(); }
  catch (error) { next(error); }
});

router.get("/overview", async (req, res) => {
  try {
    const locationId = String(req.query.location_id || "").trim();
    const locationParam = locationId && UUID_RE.test(locationId) ? locationId : null;
    const waitlist = await db.query(`SELECT w.*,COALESCE(e.full_name,e.name,'') employee_name,COALESCE(l.name,'') location_name,
      COALESCE((SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM services s WHERE s.id=ANY(w.service_ids)),'') service_names
      FROM booking_waitlist w
      LEFT JOIN employees e ON e.id=w.preferred_employee_id
      LEFT JOIN locations l ON l.id=w.location_id
      WHERE ($1::uuid IS NULL OR w.location_id=$1::uuid)
        AND w.status IN ('waiting','contacted')
      ORDER BY CASE w.status WHEN 'contacted' THEN 0 ELSE 1 END,w.created_at`, [locationParam]);
    const vacancies = await db.query(`SELECT v.*,COALESCE(e.full_name,e.name,'') employee_name,COALESCE(l.name,'') location_name,
      COALESCE((SELECT string_agg(s.name, ', ' ORDER BY s.name) FROM services s WHERE s.id=ANY(v.service_ids)),'') service_names
      FROM smart_waitlist_vacancies v
      LEFT JOIN employees e ON e.id=v.employee_id
      LEFT JOIN locations l ON l.id=v.location_id
      WHERE ($1::uuid IS NULL OR v.location_id=$1::uuid)
        AND v.status IN ('open','offered') AND v.end_time>now()
      ORDER BY v.start_time`, [locationParam]);

    const enriched: any[] = [];
    for (const vacancy of vacancies.rows) {
      const { candidates } = await candidateRows(String(vacancy.id));
      const pending = await db.query(`SELECT o.*,w.client_name,w.phone,w.email
        FROM smart_waitlist_offers o JOIN booking_waitlist w ON w.id=o.waitlist_id
        WHERE o.vacancy_id=$1::uuid AND o.status='pending' AND o.expires_at>now()
        ORDER BY o.offered_at DESC LIMIT 1`, [vacancy.id]);
      enriched.push({ ...vacancy, candidates: candidates.slice(0, 8), active_offer: pending.rows[0] || null });
    }

    res.json({
      metrics: {
        waiting: waitlist.rows.filter((x: any) => x.status === "waiting").length,
        contacted: waitlist.rows.filter((x: any) => x.status === "contacted").length,
        open_vacancies: enriched.length,
        matchable_vacancies: enriched.filter((x: any) => x.candidates.length > 0).length,
      },
      waitlist: waitlist.rows,
      vacancies: enriched,
    });
  } catch (error: any) {
    res.status(500).json({ error: "Az intelligens várólista nem tölthető be.", detail: error?.message || String(error) });
  }
});

router.post("/entries", async (req: AuthRequest, res) => {
  try {
    const locationId = String(req.body?.location_id || "").trim();
    const clientName = String(req.body?.client_name || "").trim();
    const serviceIds = Array.isArray(req.body?.service_ids) ? req.body.service_ids.map(String).filter((x: string) => UUID_RE.test(x)) : [];
    if (!UUID_RE.test(locationId) || !clientName || !serviceIds.length) return res.status(400).json({ error: "Telephely, vendégnév és legalább egy szolgáltatás kötelező." });
    const validServices = await db.query(`SELECT id FROM services WHERE id=ANY($1::uuid[]) AND COALESCE(is_active,true)=true`, [serviceIds]);
    if (validServices.rows.length !== new Set(serviceIds).size) return res.status(400).json({ error: "Egy vagy több szolgáltatás nem található vagy inaktív." });
    const preferredEmployee = String(req.body?.preferred_employee_id || "").trim();
    if (preferredEmployee && !UUID_RE.test(preferredEmployee)) return res.status(400).json({ error: "Érvénytelen preferált munkatárs." });
    const priority = clamp(Math.floor(Number(req.body?.priority_level || 0)), 0, 5);
    const { rows } = await db.query(`INSERT INTO booking_waitlist(
      location_id,client_id,client_name,phone,email,service_ids,preferred_employee_id,preferred_from,preferred_to,note,
      status,source,priority_level,accept_short_notice,auto_offer,smart_note
    ) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6::uuid[],$7::uuid,$8::timestamptz,$9::timestamptz,$10,'waiting','internal',$11,$12,$13,$14)
    RETURNING *`, [
      locationId,
      req.body?.client_id || null,
      clientName,
      req.body?.phone || null,
      req.body?.email || null,
      serviceIds,
      preferredEmployee || null,
      req.body?.preferred_from || null,
      req.body?.preferred_to || null,
      req.body?.note || null,
      priority,
      req.body?.accept_short_notice !== false,
      req.body?.auto_offer !== false,
      req.body?.smart_note || null,
    ]);
    res.status(201).json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A várólista-bejegyzés nem hozható létre.", detail: error?.message || String(error) });
  }
});

router.patch("/entries/:id", async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Érvénytelen várólista-azonosító." });
    const status = req.body?.status === undefined ? null : String(req.body.status);
    if (status !== null && !WAITLIST_STATUSES.has(status)) return res.status(400).json({ error: "Érvénytelen várólista állapot." });
    const priority = req.body?.priority_level === undefined ? null : clamp(Math.floor(Number(req.body.priority_level)), 0, 5);
    const { rows } = await db.query(`UPDATE booking_waitlist SET
      status=COALESCE($2,status),
      priority_level=COALESCE($3,priority_level),
      accept_short_notice=COALESCE($4,accept_short_notice),
      auto_offer=COALESCE($5,auto_offer),
      preferred_from=COALESCE($6::timestamptz,preferred_from),
      preferred_to=COALESCE($7::timestamptz,preferred_to),
      preferred_employee_id=COALESCE($8::uuid,preferred_employee_id),
      smart_note=COALESCE($9,smart_note),
      note=COALESCE($10,note),updated_at=now()
      WHERE id=$1::uuid RETURNING *`, [
      req.params.id,status,priority,req.body?.accept_short_notice ?? null,req.body?.auto_offer ?? null,
      req.body?.preferred_from || null,req.body?.preferred_to || null,req.body?.preferred_employee_id || null,
      req.body?.smart_note ?? null,req.body?.note ?? null,
    ]);
    if (!rows[0]) return res.status(404).json({ error: "A várólista-bejegyzés nem található." });
    res.json(rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A várólista-bejegyzés nem módosítható.", detail: error?.message || String(error) });
  }
});

router.post("/vacancies/from-appointment/:appointmentId", async (req, res) => {
  try {
    const id = String(req.params.appointmentId || "");
    if (!UUID_RE.test(id)) return res.status(400).json({ error: "Érvénytelen időpontazonosító." });
    const { rows } = await db.query(`SELECT a.id,a.location_id,a.employee_id,a.start_time,a.end_time,a.status,
      COALESCE(array_agg(aps.service_id ORDER BY aps.sort_order) FILTER (WHERE aps.service_id IS NOT NULL),'{}'::uuid[]) service_ids
      FROM appointments a LEFT JOIN appointment_services aps ON aps.appointment_id=a.id
      WHERE a.id=$1::uuid GROUP BY a.id`, [id]);
    const a = rows[0];
    if (!a) return res.status(404).json({ error: "Az időpont nem található." });
    if (!["cancelled", "canceled"].includes(String(a.status || "").toLowerCase())) return res.status(409).json({ error: "Csak lemondott időpontból képezhető várólistás kapacitás." });
    const result = await db.query(`INSERT INTO smart_waitlist_vacancies(source_appointment_id,location_id,employee_id,start_time,end_time,service_ids,status)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4::timestamptz,$5::timestamptz,$6::uuid[],CASE WHEN $5::timestamptz<=now() THEN 'expired' ELSE 'open' END)
      ON CONFLICT(source_appointment_id) WHERE source_appointment_id IS NOT NULL
      DO UPDATE SET location_id=EXCLUDED.location_id,employee_id=EXCLUDED.employee_id,start_time=EXCLUDED.start_time,end_time=EXCLUDED.end_time,service_ids=EXCLUDED.service_ids,status=EXCLUDED.status,updated_at=now()
      RETURNING *`, [a.id,a.location_id,a.employee_id,a.start_time,a.end_time,a.service_ids]);
    res.status(201).json(result.rows[0]);
  } catch (error: any) {
    res.status(500).json({ error: "A felszabadult időpont nem rögzíthető.", detail: error?.message || String(error) });
  }
});

router.get("/vacancies/:id/candidates", async (req, res) => {
  try {
    const result = await candidateRows(String(req.params.id));
    if (!result.vacancy) return res.status(404).json({ error: "A felszabadult időpont nem található." });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: "A várólistás jelöltek nem rangsorolhatók.", detail: error?.message || String(error) });
  }
});

router.post("/vacancies/:id/offer", async (req: AuthRequest, res) => {
  const cx = await db.connect();
  try {
    await cx.query("BEGIN");
    const vacancy = await getVacancy(String(req.params.id), cx, true);
    if (!vacancy) { await cx.query("ROLLBACK"); return res.status(404).json({ error: "A felszabadult időpont nem található." }); }
    if (!["open", "offered"].includes(String(vacancy.status)) || new Date(vacancy.end_time) <= new Date()) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "Ez a kapacitás már nem ajánlható fel." }); }
    const active = await cx.query(`SELECT id FROM smart_waitlist_offers WHERE vacancy_id=$1::uuid AND status='pending' AND expires_at>now() LIMIT 1`, [vacancy.id]);
    if (active.rowCount) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "Ehhez az időponthoz már fut aktív ajánlat." }); }
    const ranked = await candidateRows(String(vacancy.id), cx);
    const requestedId = String(req.body?.waitlist_id || "").trim();
    const candidate = requestedId ? ranked.candidates.find((x: any) => String(x.id) === requestedId) : ranked.candidates[0];
    if (!candidate) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "Nincs kompatibilis várólistás vendég ehhez az időponthoz." }); }
    const expiresMinutes = clamp(Math.floor(Number(req.body?.expires_minutes || 15)), 5, 120);
    const expiresAt = new Date(Date.now() + expiresMinutes * 60_000);
    const channel = String(req.body?.channel || (candidate.phone ? "sms" : "email")).toLowerCase();
    const offer = await cx.query(`INSERT INTO smart_waitlist_offers(vacancy_id,waitlist_id,score,score_breakdown,expires_at,notification_channel,notification_status,created_by)
      VALUES($1::uuid,$2::uuid,$3,$4::jsonb,$5::timestamptz,$6,'queued',$7) RETURNING *`, [
      vacancy.id,candidate.id,candidate.score,JSON.stringify(candidate.score_breakdown),expiresAt.toISOString(),channel,actor(req),
    ]);
    await cx.query(`UPDATE booking_waitlist SET status='contacted',last_offered_at=now(),offer_count=offer_count+1,updated_at=now() WHERE id=$1::uuid`, [candidate.id]);
    await cx.query(`UPDATE smart_waitlist_vacancies SET status='offered',updated_at=now() WHERE id=$1::uuid`, [vacancy.id]);
    await cx.query("COMMIT");

    let notificationStatus = "skipped";
    let notificationError: string | null = null;
    if (req.body?.send_notification !== false) {
      const when = new Intl.DateTimeFormat("hu-HU", { dateStyle: "medium", timeStyle: "short", timeZone: "Europe/Budapest" }).format(new Date(vacancy.start_time));
      const text = `Kedves ${candidate.client_name}! Felszabadult egy időpont a Kleopátra Szalonban: ${when}, ${vacancy.location_name || "szalon"}, ${candidate.service_names || "kért szolgáltatás"}. Az ajánlat ${expiresMinutes} percig él. Kérjük, jelezzen vissza a szalonnak.`;
      try {
        if (channel === "sms" && candidate.phone) await sendSms({ to: candidate.phone, text });
        else if (candidate.email) await sendEmail({ to: candidate.email, subject: "Kleopátra Szalon – felszabadult időpont", text });
        else throw new Error("A vendéghez nincs használható SMS- vagy e-mail-elérhetőség.");
        notificationStatus = "sent";
      } catch (error: any) {
        notificationStatus = "failed";
        notificationError = error?.message || String(error);
      }
    }
    await db.query(`UPDATE smart_waitlist_offers SET notification_status=$2,notification_error=$3 WHERE id=$1::uuid`, [offer.rows[0].id,notificationStatus,notificationError]);
    res.status(201).json({ ...offer.rows[0], notification_status: notificationStatus, notification_error: notificationError, candidate });
  } catch (error: any) {
    await cx.query("ROLLBACK").catch(() => undefined);
    res.status(500).json({ error: "Az ajánlat nem indítható el.", detail: error?.message || String(error) });
  } finally { cx.release(); }
});

router.post("/offers/:id/decline", async (_req, res) => {
  const cx = await db.connect();
  try {
    if (!UUID_RE.test(_req.params.id)) return res.status(400).json({ error: "Érvénytelen ajánlatazonosító." });
    await cx.query("BEGIN");
    const { rows } = await cx.query(`UPDATE smart_waitlist_offers SET status='declined',responded_at=now() WHERE id=$1::uuid AND status='pending' RETURNING *`, [_req.params.id]);
    const offer = rows[0];
    if (!offer) { await cx.query("ROLLBACK"); return res.status(404).json({ error: "Aktív ajánlat nem található." }); }
    await cx.query(`UPDATE booking_waitlist SET status='waiting',updated_at=now() WHERE id=$1::uuid AND booked_appointment_id IS NULL`, [offer.waitlist_id]);
    await cx.query(`UPDATE smart_waitlist_vacancies SET status='open',updated_at=now() WHERE id=$1::uuid AND status='offered'`, [offer.vacancy_id]);
    await cx.query("COMMIT");
    res.json({ ok: true, offer });
  } catch (error: any) {
    await cx.query("ROLLBACK").catch(() => undefined);
    res.status(500).json({ error: "Az ajánlat elutasítása sikertelen.", detail: error?.message || String(error) });
  } finally { cx.release(); }
});

router.post("/offers/:id/book", async (req: AuthRequest, res) => {
  const cx = await db.connect();
  let appointmentId: string | null = null;
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: "Érvénytelen ajánlatazonosító." });
    await ensureBookingWorkOrderSchema(cx);
    await cx.query("BEGIN");
    const offerQ = await cx.query(`SELECT o.*,w.location_id,w.client_id,w.client_name,w.phone,w.email,w.service_ids,w.preferred_employee_id,
      v.source_appointment_id,v.employee_id,v.start_time,v.end_time,v.status vacancy_status
      FROM smart_waitlist_offers o
      JOIN booking_waitlist w ON w.id=o.waitlist_id
      JOIN smart_waitlist_vacancies v ON v.id=o.vacancy_id
      WHERE o.id=$1::uuid FOR UPDATE OF o,w,v`, [req.params.id]);
    const item = offerQ.rows[0];
    if (!item) { await cx.query("ROLLBACK"); return res.status(404).json({ error: "Az ajánlat nem található." }); }
    if (!OFFER_STATUSES.has(String(item.status)) || !["pending", "accepted"].includes(String(item.status))) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "Ez az ajánlat már nem foglalható." }); }
    if (new Date(item.expires_at) <= new Date()) { await cx.query(`UPDATE smart_waitlist_offers SET status='expired',responded_at=now() WHERE id=$1::uuid`, [item.id]); await cx.query("COMMIT"); return res.status(409).json({ error: "Az ajánlat lejárt." }); }
    if (new Date(item.end_time) <= new Date()) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "A felszabadult időpont már elmúlt." }); }
    if (await detectComplexSource(cx, item.source_appointment_id)) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "Ez komplex/több erőforrásos foglalás volt; biztonsági okból kézi újrafoglalás szükséges." }); }

    const employeeId = String(item.preferred_employee_id || item.employee_id || "");
    if (!UUID_RE.test(employeeId)) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "A felszabadult időponthoz nincs foglalható munkatárs." }); }
    await cx.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`smart-waitlist-staff:${employeeId}`]);
    const services = await cx.query(`SELECT id,name,COALESCE(duration_minutes,30)::int duration_minutes,COALESCE(promo_price,list_price,base_price,0)::numeric price
      FROM services WHERE id=ANY($1::uuid[]) AND COALESCE(is_active,true)=true`, [item.service_ids || []]);
    if (services.rows.length !== new Set((item.service_ids || []).map(String)).size) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "A várólistán szereplő egyik szolgáltatás már nem aktív." }); }
    const duration = services.rows.reduce((sum: number, x: any) => sum + Number(x.duration_minutes || 30), 0);
    const start = new Date(item.start_time);
    const end = new Date(start.getTime() + duration * 60_000);
    if (end > new Date(item.end_time)) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "A kért szolgáltatások nem férnek bele a felszabadult időablakba." }); }

    const employeeCheck = await cx.query(`SELECT e.id FROM employees e WHERE e.id=$1::uuid AND COALESCE(e.active,true)=true
      AND (e.location_id=$2::uuid OR e.location_id IS NULL)
      AND (
        NOT EXISTS (SELECT 1 FROM employee_service_overrides eo0 WHERE eo0.employee_id=e.id)
        OR NOT EXISTS (
          SELECT 1 FROM unnest($3::uuid[]) sid(service_id)
          WHERE NOT EXISTS (SELECT 1 FROM employee_service_overrides eo WHERE eo.employee_id=e.id AND eo.service_id=sid.service_id)
        )
      ) LIMIT 1`, [employeeId,item.location_id,item.service_ids]);
    if (!employeeCheck.rows[0]) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "A munkatárs nem végez minden kért szolgáltatást." }); }

    const conflict = await cx.query(`SELECT id FROM appointments WHERE employee_id=$1::uuid AND status NOT IN ('cancelled','canceled','no_show')
      AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`, [employeeId,start.toISOString(),end.toISOString()]);
    const breakConflict = await cx.query(`SELECT id FROM appointment_technical_breaks WHERE employee_id=$1::uuid
      AND start_time<$3::timestamptz AND end_time>$2::timestamptz LIMIT 1`, [employeeId,start.toISOString(),end.toISOString()]);
    if (conflict.rowCount || breakConflict.rowCount) { await cx.query("ROLLBACK"); return res.status(409).json({ error: "A felszabadult időpont időközben foglalttá vált." }); }

    let clientId = item.client_id;
    if (!clientId) {
      const existing = await cx.query(`SELECT id FROM clients WHERE location_id=$1::uuid AND
        (($2<>'' AND regexp_replace(COALESCE(phone,''),'[^0-9]','','g')=regexp_replace($2,'[^0-9]','','g'))
        OR ($3<>'' AND lower(COALESCE(email,''))=lower($3))) ORDER BY updated_at DESC NULLS LAST LIMIT 1`, [item.location_id,item.phone || "",item.email || ""]);
      clientId = existing.rows[0]?.id;
      if (!clientId) {
        const created = await cx.query(`INSERT INTO clients(full_name,name,phone,email,location_id,is_active,source,created_at,updated_at)
          VALUES($1,$1,$2,$3,$4::uuid,true,'smart_waitlist',now(),now()) RETURNING id`, [item.client_name,item.phone || null,item.email || null,item.location_id]);
        clientId = created.rows[0].id;
      }
    }

    const cancellationToken = crypto.randomUUID();
    const title = services.rows.map((x: any) => x.name).join(", ");
    const appointment = await cx.query(`INSERT INTO appointments(employee_id,client_id,location_id,title,start_time,end_time,status,notes,booking_source,cancellation_token,confirmation_required,confirmed_at,updated_at)
      VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5::timestamptz,$6::timestamptz,'confirmed',$7,'smart_waitlist',$8::uuid,false,now(),now()) RETURNING id::text`, [
      employeeId,clientId,item.location_id,title,start.toISOString(),end.toISOString(),`Smart Waitlist – várólistáról betöltve (${item.waitlist_id})`,cancellationToken,
    ]);
    appointmentId = String(appointment.rows[0].id);
    for (let i = 0; i < services.rows.length; i += 1) {
      const s = services.rows[i];
      await cx.query(`INSERT INTO appointment_services(appointment_id,service_id,duration_minutes,price,discount_percent,sort_order)
        VALUES($1::uuid,$2::uuid,$3,$4,0,$5)`, [appointmentId,s.id,s.duration_minutes,s.price,i]);
    }
    await cx.query(`INSERT INTO appointment_change_log(appointment_id,action,actor_key,after_data,note)
      VALUES($1::uuid,'smart_waitlist_filled',$2,$3::jsonb,$4)`, [appointmentId,actor(req),JSON.stringify({ waitlist_id:item.waitlist_id,offer_id:item.id,vacancy_id:item.vacancy_id,source_appointment_id:item.source_appointment_id }),"Felszabadult időpont intelligens várólistáról feltöltve"]);
    await cx.query(`UPDATE smart_waitlist_offers SET status='accepted',responded_at=now(),booked_appointment_id=$2::uuid WHERE id=$1::uuid`, [item.id,appointmentId]);
    await cx.query(`UPDATE smart_waitlist_offers SET status='cancelled',responded_at=now() WHERE vacancy_id=$1::uuid AND id<>$2::uuid AND status='pending'`, [item.vacancy_id,item.id]);
    await cx.query(`UPDATE smart_waitlist_vacancies SET status='filled',filled_at=now(),updated_at=now() WHERE id=$1::uuid`, [item.vacancy_id]);
    await cx.query(`UPDATE booking_waitlist SET status='booked',booked_appointment_id=$2::uuid,updated_at=now() WHERE id=$1::uuid`, [item.waitlist_id,appointmentId]);
    await cx.query("COMMIT");

    let workOrder: any = { work_order_id: null, work_order_number: null };
    try {
      await cx.query("BEGIN");
      workOrder = await ensureBookingWorkOrder(cx, appointmentId, actor(req));
      await cx.query("COMMIT");
    } catch (error: any) {
      await cx.query("ROLLBACK").catch(() => undefined);
      console.error("[smart-waitlist] work order deferred", { appointment_id: appointmentId, error: error?.message || String(error) });
    }
    try { await queueAppointmentCommunications(appointmentId, "confirmed"); }
    catch (error: any) { console.error("[smart-waitlist] confirmation communication deferred", error?.message || error); }

    res.status(201).json({ ok: true, appointment_id: appointmentId, cancellation_token: cancellationToken, ...workOrder });
  } catch (error: any) {
    await cx.query("ROLLBACK").catch(() => undefined);
    res.status(500).json({ error: "A várólistás vendég foglalásba emelése sikertelen.", detail: error?.message || String(error), appointment_id: appointmentId });
  } finally { cx.release(); }
});

export { ensureSmartWaitlistSchema, candidateRows };
export default router;
