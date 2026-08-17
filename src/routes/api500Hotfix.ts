import { Router, type NextFunction, type Response } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { locationManagerScope } from "../middleware/locationManagerScope";
import timetableSelfAccess from "../middleware/timetableSelfAccess";
import virCustomizerRouter from "./virCustomizer";

const router = Router();

type JsonRow = Record<string, any>;

const text = (value: unknown): string => value === null || value === undefined ? "" : String(value);
const nullableText = (value: unknown): string | null => {
  const v = text(value).trim();
  return v ? v : null;
};
const numberOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const isActive = (value: unknown): boolean => !["false", "f", "0", "no", "off"].includes(text(value).trim().toLowerCase());
const jsonObject = (value: unknown): JsonRow => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRow : {};
const asyncRoute = (handler: (req: AuthRequest, res: Response, next: NextFunction) => Promise<any>) =>
  (req: AuthRequest, res: Response, next: NextFunction) => handler(req, res, next).catch(next);

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query("SELECT to_regclass($1) IS NOT NULL AS ok", [`public.${name}`]);
  return Boolean(rows[0]?.ok);
}

async function loadJsonTable(table: string, ids?: string[]): Promise<JsonRow[]> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(table)) throw new Error("Unsafe table name");
  if (!(await tableExists(table))) return [];
  if (ids && ids.length === 0) return [];
  const sql = ids
    ? `SELECT to_jsonb(t) AS data FROM ${table} t WHERE t.id::text = ANY($1::text[])`
    : `SELECT to_jsonb(t) AS data FROM ${table} t`;
  const { rows } = await db.query(sql, ids ? [ids] : []);
  return rows.map((row: any) => jsonObject(row.data));
}

function nameFrom(row: JsonRow, fallback = ""): string {
  const direct = nullableText(row.full_name) || nullableText(row.name) || nullableText(row.display_name);
  if (direct) return direct;
  const composed = [nullableText(row.last_name), nullableText(row.first_name)].filter(Boolean).join(" ").trim();
  return composed || fallback;
}

async function employeeDtos(locationId: string | null, includeInactive = false): Promise<JsonRow[]> {
  const { rows } = await db.query(
    `SELECT to_jsonb(e) AS data
       FROM employees e
      WHERE ($1::text IS NULL OR NULLIF(to_jsonb(e)->>'location_id','') = $1)
      ORDER BY COALESCE(NULLIF(to_jsonb(e)->>'full_name',''), NULLIF(to_jsonb(e)->>'last_name',''), NULLIF(to_jsonb(e)->>'first_name',''), '')`,
    [locationId],
  );

  const raw = rows.map((row: any) => jsonObject(row.data)).filter((row: JsonRow) => includeInactive || isActive(row.active));
  const locationIds = Array.from(new Set(raw.map((row) => nullableText(row.location_id)).filter(Boolean))) as string[];
  const positionIds = Array.from(new Set(raw.map((row) => nullableText(row.position_id)).filter(Boolean))) as string[];
  const [locations, positions] = await Promise.all([
    loadJsonTable("locations", locationIds),
    loadJsonTable("hr_positions", positionIds),
  ]);
  const locationMap = new Map(locations.map((row) => [text(row.id), nameFrom(row)]));
  const positionMap = new Map(positions.map((row) => [text(row.id), nameFrom(row)]));

  return raw.map((row) => {
    const location_id = nullableText(row.location_id);
    const position_id = nullableText(row.position_id);
    const full_name = nameFrom(row, "Munkatárs");
    return {
      id: text(row.id),
      location_id,
      location_name: location_id ? locationMap.get(location_id) || null : null,
      full_name,
      first_name: nullableText(row.first_name),
      last_name: nullableText(row.last_name),
      email: nullableText(row.email),
      phone: nullableText(row.phone),
      birth_date: row.birth_date ?? null,
      qualification: nullableText(row.qualification),
      employment_type: nullableText(row.employment_type),
      position_id,
      position_name: position_id ? positionMap.get(position_id) || nullableText(row.position_name) : nullableText(row.position_name),
      monthly_wage: numberOrNull(row.monthly_wage),
      hourly_wage: numberOrNull(row.hourly_wage),
      commission_percent: numberOrNull(row.commission_percent),
      photo_url: nullableText(row.photo_url) || nullableText(row.avatar_url) || nullableText(row.image_url),
      active: isActive(row.active),
      login_name: nullableText(row.login_name),
      role: row.role ?? null,
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    };
  });
}

router.get(
  "/employees",
  requireAuth,
  locationManagerScope("employees"),
  asyncRoute(async (req, res) => {
    const locationId = nullableText(req.query.location_id);
    const includeInactive = text(req.query.include_inactive) === "1";
    const employees = await employeeDtos(locationId, includeInactive);
    res.setHeader("X-Kleo-Hotfix", "api500-employees-v1");
    return res.json(employees);
  }),
);

router.get(
  "/timetable",
  requireAuth,
  locationManagerScope("timetable"),
  timetableSelfAccess,
  asyncRoute(async (req, res) => {
    const from = text(req.query.from).trim();
    const to = text(req.query.to).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: "Érvényes from és to dátum szükséges." });
    }
    const locationId = nullableText(req.query.location_id);
    const employees = await employeeDtos(locationId, false);

    if (!(await tableExists("appointments"))) {
      res.setHeader("X-Kleo-Hotfix", "api500-timetable-v1");
      return res.json({ employees, appointments: [] });
    }

    const { rows } = await db.query(
      `SELECT to_jsonb(a) AS data
         FROM appointments a
        WHERE NULLIF(to_jsonb(a)->>'start_time','')::timestamptz >= ($1::date)::timestamptz
          AND NULLIF(to_jsonb(a)->>'start_time','')::timestamptz < (($2::date + INTERVAL '1 day')::timestamptz)
          AND ($3::text IS NULL OR NULLIF(to_jsonb(a)->>'location_id','') = $3)
        ORDER BY NULLIF(to_jsonb(a)->>'start_time','')::timestamptz`,
      [from, to, locationId],
    );
    const appointmentRows = rows.map((row: any) => jsonObject(row.data));
    const appointmentIds = appointmentRows.map((row) => text(row.id)).filter(Boolean);
    const clientIds = Array.from(new Set(appointmentRows.map((row) => nullableText(row.client_id)).filter(Boolean))) as string[];
    const workOrderIds = Array.from(new Set(appointmentRows.map((row) => nullableText(row.work_order_id)).filter(Boolean))) as string[];
    const locationIds = Array.from(new Set(appointmentRows.map((row) => nullableText(row.location_id)).filter(Boolean))) as string[];

    const [clients, workOrders, locations, serviceRows, productRows] = await Promise.all([
      loadJsonTable("clients", clientIds),
      loadJsonTable("work_orders", workOrderIds),
      loadJsonTable("locations", locationIds),
      (async () => {
        if (!(await tableExists("appointment_services")) || appointmentIds.length === 0) return [] as JsonRow[];
        const result = await db.query(
          `SELECT to_jsonb(x) AS data FROM appointment_services x WHERE NULLIF(to_jsonb(x)->>'appointment_id','') = ANY($1::text[])`,
          [appointmentIds],
        );
        return result.rows.map((row: any) => jsonObject(row.data));
      })(),
      (async () => {
        if (!(await tableExists("appointment_products")) || appointmentIds.length === 0) return [] as JsonRow[];
        const result = await db.query(
          `SELECT to_jsonb(x) AS data FROM appointment_products x WHERE NULLIF(to_jsonb(x)->>'appointment_id','') = ANY($1::text[])`,
          [appointmentIds],
        );
        return result.rows.map((row: any) => jsonObject(row.data));
      })(),
    ]);

    const serviceIds = Array.from(new Set(serviceRows.map((row) => nullableText(row.service_id)).filter(Boolean))) as string[];
    const services = await loadJsonTable("services", serviceIds);
    const serviceMap = new Map(services.map((row) => [text(row.id), nameFrom(row)]));
    const clientMap = new Map(clients.map((row) => [text(row.id), nameFrom(row)]));
    const locationMap = new Map(locations.map((row) => [text(row.id), nameFrom(row)]));
    const workOrderMap = new Map<string, JsonRow>(workOrders.map((row) => [text(row.id), row]));

    const servicesByAppointment = new Map<string, JsonRow[]>();
    for (const row of serviceRows) {
      const key = text(row.appointment_id);
      if (!key) continue;
      const list = servicesByAppointment.get(key) || [];
      list.push(row);
      servicesByAppointment.set(key, list);
    }
    const productsByAppointment = new Map<string, JsonRow[]>();
    for (const row of productRows) {
      const key = text(row.appointment_id);
      if (!key) continue;
      const list = productsByAppointment.get(key) || [];
      list.push(row);
      productsByAppointment.set(key, list);
    }

    const appointments = appointmentRows.map((row) => {
      const id = text(row.id);
      const servicesForAppointment = servicesByAppointment.get(id) || [];
      const productsForAppointment = productsByAppointment.get(id) || [];
      const service_names = servicesForAppointment
        .map((item) => nullableText(item.name) || (nullableText(item.service_id) ? serviceMap.get(text(item.service_id)) || "" : ""))
        .filter(Boolean);
      const serviceTotal = servicesForAppointment.reduce((sum, item) => sum + (numberOrNull(item.price) || 0), 0);
      const productTotal = productsForAppointment.reduce((sum, item) => sum + (numberOrNull(item.qty) || 1) * (numberOrNull(item.price) || 0), 0);
      const status = text(row.status).trim().toLowerCase();
      const workOrder = nullableText(row.work_order_id) ? workOrderMap.get(text(row.work_order_id)) : undefined;
      const workOrderStatus = text(workOrder?.status).trim().toLowerCase();
      const workOrderClosed = Boolean(workOrder && (workOrderStatus === "completed" || workOrder.locked_at || workOrder.archived_at));
      const operational_status = workOrderClosed || ["completed", "paid"].includes(status)
        ? "work_order_closed"
        : workOrderStatus === "in_progress" || status === "in_progress"
          ? "in_progress"
          : workOrderStatus === "arrived" || status === "arrived"
            ? "arrived"
            : status || "waiting";
      const clientId = nullableText(row.client_id);
      const appointmentLocationId = nullableText(row.location_id);
      return {
        id,
        employee_id: nullableText(row.employee_id),
        client_id: clientId,
        client_name: clientId ? clientMap.get(clientId) || "" : "",
        location_id: appointmentLocationId,
        location_name: appointmentLocationId ? locationMap.get(appointmentLocationId) || null : null,
        title: nullableText(row.title) || service_names.join(", ") || "Időpont",
        start_time: row.start_time ?? null,
        end_time: row.end_time ?? null,
        status: nullableText(row.status),
        operational_status,
        notes: nullableText(row.notes),
        service_names,
        total: serviceTotal + productTotal,
      };
    });

    res.setHeader("X-Kleo-Hotfix", "api500-timetable-v1");
    return res.json({ employees, appointments });
  }),
);

// The current source already contains this router under transactions/knowledge-base,
// but production can temporarily run an older transactions bundle. Mounting it here
// removes the observed 404 immediately after this build is deployed.
router.use("/transactions/knowledge-base/vir-customizer", virCustomizerRouter);

export default router;
