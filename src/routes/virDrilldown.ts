import { Router, Request, Response } from "express";
import crypto from "crypto";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { parseRoleKeys } from "../security/roles";

const router = Router();

const clean = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max);
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

type FranchiseLeadData = {
  name: string;
  email: string;
  phone: string;
  consent: boolean;
  variant: string;
  extra: Record<string, unknown>;
  tracking: Record<string, unknown>;
};

let franchiseLeadSchemaPromise: Promise<void> | null = null;

function ensureFranchiseLeadSchema() {
  if (!franchiseLeadSchemaPromise) {
    franchiseLeadSchemaPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS franchise_leads (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        email text NOT NULL,
        phone text NOT NULL,
        consent boolean NOT NULL DEFAULT false,
        variant text NOT NULL DEFAULT 'franchise',
        extra jsonb NOT NULL DEFAULT '{}'::jsonb,
        tracking jsonb NOT NULL DEFAULT '{}'::jsonb,
        mailchimp_status text NOT NULL DEFAULT 'pending',
        mailchimp_error text,
        attempt_count integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        synced_at timestamptz
      );
      CREATE INDEX IF NOT EXISTS franchise_leads_pending_idx
        ON franchise_leads(mailchimp_status, next_attempt_at, created_at);
      CREATE INDEX IF NOT EXISTS franchise_leads_email_idx
        ON franchise_leads(lower(email), created_at DESC);
    `).then(() => undefined).catch((error) => {
      franchiseLeadSchemaPromise = null;
      throw error;
    });
  }
  return franchiseLeadSchemaPromise;
}

async function readPublicLeadBody(req: Request): Promise<any> {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error("lead_payload_too_large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("invalid_lead_payload")); }
    });
    req.on("error", reject);
  });
}

function mailchimpConfig() {
  const apiKey = clean(process.env.MAILCHIMP_API_KEY, 500);
  const audienceId = clean(process.env.MAILCHIMP_AUDIENCE_ID, 200);
  const serverPrefix = clean(process.env.MAILCHIMP_SERVER_PREFIX || apiKey.split("-").pop(), 80);
  if (!apiKey || !audienceId || !serverPrefix) throw new Error("MAILCHIMP_NOT_CONFIGURED");
  return { apiKey, audienceId, serverPrefix };
}

async function mailchimpFetch(pathname: string, init: RequestInit) {
  const cfg = mailchimpConfig();
  const auth = Buffer.from(`kleoszalon:${cfg.apiKey}`).toString("base64");
  return fetch(`https://${cfg.serverPrefix}.api.mailchimp.com/3.0${pathname}`, {
    ...init,
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function buildMailchimpNote(data: FranchiseLeadData) {
  const extraLines = Object.entries(data.extra || {}).slice(0, 30).map(([key, value]) => `${clean(key, 80)}: ${clean(value, 1200)}`);
  const trackingLines = Object.entries(data.tracking || {}).slice(0, 12).map(([key, value]) => `${clean(key, 80)}: ${clean(value, 800)}`);
  return [
    `Franchise lead – ${new Date().toISOString()}`,
    `Név: ${data.name}`,
    `E-mail: ${data.email}`,
    `Telefon: ${data.phone}`,
    `Variáns: ${data.variant}`,
    "Adatkezelési hozzájárulás: igen",
    extraLines.length ? "\nRészletes kérdőív:\n" + extraLines.join("\n") : "",
    trackingLines.length ? "\nKampányadatok:\n" + trackingLines.join("\n") : "",
  ].filter(Boolean).join("\n").slice(0, 10000);
}

async function syncFranchiseLeadToMailchimp(leadId: string, data: FranchiseLeadData) {
  try {
    const cfg = mailchimpConfig();
    const subscriberHash = crypto.createHash("md5").update(data.email).digest("hex");
    const memberPath = `/lists/${encodeURIComponent(cfg.audienceId)}/members/${subscriberHash}`;
    const statusIfNew = process.env.MAILCHIMP_DOUBLE_OPT_IN === "1" ? "pending" : "subscribed";

    const memberResponse = await mailchimpFetch(memberPath, {
      method: "PUT",
      body: JSON.stringify({ email_address: data.email, status_if_new: statusIfNew }),
    });
    if (!memberResponse.ok) throw new Error(`mailchimp_member_${memberResponse.status}`);

    const tags = [
      "Franchise lead",
      data.variant,
      clean(data.tracking?.utm_source, 80),
      clean(data.tracking?.utm_campaign, 80),
    ].filter(Boolean).slice(0, 6).map((name) => ({ name, status: "active" }));

    const tagResponse = await mailchimpFetch(`${memberPath}/tags`, {
      method: "POST",
      body: JSON.stringify({ tags }),
    });
    if (!tagResponse.ok) console.error("[franchise-mailchimp-tags]", tagResponse.status);

    const noteResponse = await mailchimpFetch(`${memberPath}/notes`, {
      method: "POST",
      body: JSON.stringify({ note: buildMailchimpNote(data) }),
    });
    if (!noteResponse.ok) throw new Error(`mailchimp_note_${noteResponse.status}`);

    await pool.query(`
      UPDATE franchise_leads
      SET mailchimp_status='synced', mailchimp_error=NULL, attempt_count=attempt_count+1,
          synced_at=now(), updated_at=now()
      WHERE id=$1::uuid
    `, [leadId]);
    return true;
  } catch (error: any) {
    const message = clean(error?.message || error || "mailchimp_sync_failed", 1000);
    await pool.query(`
      UPDATE franchise_leads
      SET mailchimp_status='pending', mailchimp_error=$2, attempt_count=attempt_count+1,
          next_attempt_at=now() + interval '10 minutes', updated_at=now()
      WHERE id=$1::uuid
    `, [leadId, message]).catch((dbError) => console.error("[franchise-lead-queue-update]", dbError?.message || dbError));
    console.error("[franchise-mailchimp-sync]", message);
    return false;
  }
}

async function retryPendingFranchiseLeads() {
  try {
    await ensureFranchiseLeadSchema();
    if (!process.env.MAILCHIMP_API_KEY || !process.env.MAILCHIMP_AUDIENCE_ID) return;
    const pending = await pool.query(`
      SELECT id::text, name, email, phone, consent, variant, extra, tracking
      FROM franchise_leads
      WHERE mailchimp_status='pending' AND next_attempt_at <= now()
      ORDER BY created_at ASC
      LIMIT 20
    `);
    for (const row of pending.rows) {
      await syncFranchiseLeadToMailchimp(row.id, {
        name: clean(row.name, 160),
        email: clean(row.email, 200).toLowerCase(),
        phone: clean(row.phone, 80),
        consent: Boolean(row.consent),
        variant: clean(row.variant || "franchise", 80),
        extra: row.extra && typeof row.extra === "object" ? row.extra : {},
        tracking: row.tracking && typeof row.tracking === "object" ? row.tracking : {},
      });
    }
  } catch (error: any) {
    console.error("[franchise-lead-retry]", error?.message || error);
  }
}

const franchiseRetryTimer = setInterval(() => {
  retryPendingFranchiseLeads().catch(() => undefined);
}, 10 * 60 * 1000);
franchiseRetryTimer.unref?.();

router.post("/franchise-leads", async (req: Request, res: Response) => {
  try {
    const body = await readPublicLeadBody(req);
    const data: FranchiseLeadData = {
      name: clean(body?.name, 160),
      email: clean(body?.email, 200).toLowerCase(),
      phone: clean(body?.phone, 80),
      consent: body?.consent === true,
      variant: clean(body?.variant || "franchise", 80).replace(/[^a-zA-Z0-9_-]/g, "-"),
      extra: body?.extra && typeof body.extra === "object" ? body.extra : {},
      tracking: body?.tracking && typeof body.tracking === "object" ? body.tracking : {},
    };

    if (data.name.length < 2 || !validEmail(data.email) || data.phone.length < 6 || !data.consent) {
      return res.status(400).json({ ok: false, error: "invalid_franchise_lead", message: "Név, érvényes e-mail, telefonszám és adatkezelési hozzájárulás szükséges." });
    }

    await ensureFranchiseLeadSchema();
    const inserted = await pool.query(`
      INSERT INTO franchise_leads(name,email,phone,consent,variant,extra,tracking,mailchimp_status)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'pending')
      RETURNING id::text
    `, [data.name, data.email, data.phone, data.consent, data.variant, JSON.stringify(data.extra), JSON.stringify(data.tracking)]);
    const leadId = inserted.rows[0].id as string;

    const synced = await syncFranchiseLeadToMailchimp(leadId, data);
    return res.status(synced ? 201 : 202).json({ ok: true, queued: !synced, lead_id: leadId });
  } catch (error: any) {
    console.error("[franchise-lead]", error?.message || error);
    return res.status(500).json({ ok: false, error: "franchise_lead_failed" });
  }
});

router.use(requireAuth);

function scopedLocation(req: AuthRequest, res: Response): string | null | undefined {
  if (parseRoleKeys(req.user?.role).includes("admin")) return null;
  const own = req.user?.location_id == null ? "" : String(req.user.location_id).trim();
  if (!own) {
    res.status(403).json({ ok: false, error: "A felhasználóhoz nincs telephely rendelve." });
    return undefined;
  }
  return own;
}

router.get("/staff/:staffId", async (req: AuthRequest, res: Response) => {
  try {
    const { staffId } = req.params;
    const locationId = scopedLocation(req, res);
    if (locationId === undefined) return;

    const staffSql = `
      SELECT
        e.id AS employee_id,
        e.full_name,
        e.short_name,
        COALESCE(sp.appointments_count, 0) AS appointments_count,
        COALESCE(sp.completed_count, 0) AS completed_count,
        COALESCE(sp.revenue_total, 0) AS revenue_total,
        COALESCE(sp.revenue_per_hour, 0) AS revenue_per_hour
      FROM employees e
      LEFT JOIN vw_vir_staff_performance sp ON sp.employee_id = e.id
      WHERE e.id = $1
        AND ($2::uuid IS NULL OR e.location_id = $2::uuid)
      LIMIT 1
    `;
    const servicesSql = `
      SELECT
        s.id AS service_id,
        s.name AS service_name,
        COUNT(*)::int AS bookings_count,
        COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total
      FROM appointment_services aps
      JOIN appointments a ON a.id = aps.appointment_id
      JOIN services s ON s.id = aps.service_id
      WHERE a.employee_id = $1
        AND ($2::uuid IS NULL OR a.location_id = $2::uuid)
      GROUP BY s.id, s.name
      ORDER BY revenue_total DESC, bookings_count DESC
    `;
    const [staff, services] = await Promise.all([
      pool.query(staffSql, [staffId, locationId]),
      pool.query(servicesSql, [staffId, locationId]),
    ]);

    if (!staff.rows[0]) {
      return res.status(404).json({ ok: false, error: "A munkatárs nem található vagy nincs hozzá jogosultsága." });
    }

    return res.json({ ok: true, data: { staff: staff.rows[0], services: services.rows, recent_appointments: [] } });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "staff_drilldown_failed" });
  }
});

router.get("/service/:serviceId", async (req: AuthRequest, res: Response) => {
  try {
    const { serviceId } = req.params;
    const locationId = scopedLocation(req, res);
    if (locationId === undefined) return;

    const serviceSql = `
      SELECT
        v.service_id,
        v.service_name,
        v.bookings_count,
        v.revenue_total,
        v.avg_price
      FROM vw_vir_service_performance v
      WHERE v.service_id = $1
        AND ($2::uuid IS NULL OR v.location_id = $2::uuid)
      LIMIT 1
    `;
    const staffSql = `
      SELECT
        e.id AS employee_id,
        COALESCE(e.short_name, e.full_name) AS staff_name,
        COUNT(*)::int AS bookings_count,
        COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total
      FROM appointment_services aps
      JOIN appointments a ON a.id = aps.appointment_id
      JOIN employees e ON e.id = a.employee_id
      WHERE aps.service_id = $1
        AND ($2::uuid IS NULL OR a.location_id = $2::uuid)
      GROUP BY e.id, COALESCE(e.short_name, e.full_name)
      ORDER BY revenue_total DESC, bookings_count DESC
    `;
    const [service, staff] = await Promise.all([
      pool.query(serviceSql, [serviceId, locationId]),
      pool.query(staffSql, [serviceId, locationId]),
    ]);

    if (!service.rows[0]) {
      return res.status(404).json({ ok: false, error: "A szolgáltatás nem található vagy nincs hozzá jogosultsága." });
    }

    return res.json({ ok: true, data: { service: service.rows[0], staff: staff.rows, recent_appointments: [] } });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "service_drilldown_failed" });
  }
});

export default router;
