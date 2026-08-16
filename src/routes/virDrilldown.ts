import { Router, Request, Response } from "express";
import crypto from "crypto";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { parseRoleKeys } from "../security/roles";

const router = Router();

const clean = (value: unknown, max = 500) => String(value ?? "").trim().slice(0, max);
const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

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

router.post("/franchise-leads", async (req: Request, res: Response) => {
  try {
    const body = await readPublicLeadBody(req);
    const name = clean(body?.name, 160);
    const email = clean(body?.email, 200).toLowerCase();
    const phone = clean(body?.phone, 80);
    const consent = body?.consent === true;
    const variant = clean(body?.variant || "franchise", 80).replace(/[^a-zA-Z0-9_-]/g, "-");
    const extra = body?.extra && typeof body.extra === "object" ? body.extra : {};
    const tracking = body?.tracking && typeof body.tracking === "object" ? body.tracking : {};

    if (name.length < 2 || !validEmail(email) || phone.length < 6 || !consent) {
      return res.status(400).json({ ok: false, error: "invalid_franchise_lead", message: "Név, érvényes e-mail, telefonszám és adatkezelési hozzájárulás szükséges." });
    }

    const cfg = mailchimpConfig();
    const subscriberHash = crypto.createHash("md5").update(email).digest("hex");
    const memberPath = `/lists/${encodeURIComponent(cfg.audienceId)}/members/${subscriberHash}`;
    const statusIfNew = process.env.MAILCHIMP_DOUBLE_OPT_IN === "1" ? "pending" : "subscribed";

    const memberResponse = await mailchimpFetch(memberPath, {
      method: "PUT",
      body: JSON.stringify({
        email_address: email,
        status_if_new: statusIfNew,
      }),
    });

    if (!memberResponse.ok) {
      const detail = (await memberResponse.text()).slice(0, 1200);
      console.error("[franchise-mailchimp-member]", memberResponse.status, detail);
      return res.status(502).json({ ok: false, error: "mailchimp_member_failed" });
    }

    const tags = ["Franchise lead", variant, clean(tracking.utm_source, 80), clean(tracking.utm_campaign, 80)]
      .filter(Boolean)
      .slice(0, 6)
      .map((name) => ({ name, status: "active" }));
    const tagResponse = await mailchimpFetch(`${memberPath}/tags`, {
      method: "POST",
      body: JSON.stringify({ tags }),
    });
    if (!tagResponse.ok) console.error("[franchise-mailchimp-tags]", tagResponse.status, (await tagResponse.text()).slice(0, 600));

    const extraLines = Object.entries(extra).slice(0, 30).map(([key, value]) => `${clean(key, 80)}: ${clean(value, 1200)}`);
    const trackingLines = Object.entries(tracking).slice(0, 12).map(([key, value]) => `${clean(key, 80)}: ${clean(value, 800)}`);
    const note = [
      `Franchise lead – ${new Date().toISOString()}`,
      `Név: ${name}`,
      `E-mail: ${email}`,
      `Telefon: ${phone}`,
      `Variáns: ${variant}`,
      "Adatkezelési hozzájárulás: igen",
      extraLines.length ? "\nRészletes kérdőív:\n" + extraLines.join("\n") : "",
      trackingLines.length ? "\nKampányadatok:\n" + trackingLines.join("\n") : "",
    ].filter(Boolean).join("\n").slice(0, 10000);

    const noteResponse = await mailchimpFetch(`${memberPath}/notes`, {
      method: "POST",
      body: JSON.stringify({ note }),
    });
    if (!noteResponse.ok) {
      const detail = (await noteResponse.text()).slice(0, 1200);
      console.error("[franchise-mailchimp-note]", noteResponse.status, detail);
      return res.status(502).json({ ok: false, error: "mailchimp_note_failed" });
    }

    return res.status(201).json({ ok: true });
  } catch (error: any) {
    const code = error?.message === "MAILCHIMP_NOT_CONFIGURED" ? "MAILCHIMP_NOT_CONFIGURED" : "franchise_lead_failed";
    console.error("[franchise-lead]", code, error?.message || error);
    return res.status(code === "MAILCHIMP_NOT_CONFIGURED" ? 503 : 500).json({ ok: false, error: code });
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
