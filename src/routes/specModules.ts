import * as express from "express";
import { randomUUID } from "crypto";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { ensureVirSpecModules } from "../virSpec/ensureVirSpecModules";

const router = express.Router();
const NO_LOCATION_SCOPE = "__NO_LOCATION_SCOPE__";

type AsyncHandler = (
  req: AuthRequest,
  res: express.Response,
  next: express.NextFunction
) => Promise<unknown>;

const asyncRoute = (handler: AsyncHandler) =>
  (req: AuthRequest, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(handler(req, res, next)).catch(next);

function roleKeys(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String).map((value) => value.toLowerCase());
  const value = String(raw ?? "").trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.toLowerCase());
  } catch {
    // A régi adatbázisban vesszővel elválasztott szerepkör is előfordul.
  }
  return value
    .split(",")
    .map((item) => item.replace(/[\[\]"]/g, "").trim().toLowerCase())
    .filter(Boolean);
}

function isElevated(req: AuthRequest) {
  const roles = roleKeys(req.user?.role);
  return roles.includes("admin") || roles.includes("manager");
}

function requestedLocation(req: AuthRequest): string | null {
  const explicit = req.query.location_id ?? req.body?.location_id;
  if (isElevated(req)) {
    if (explicit !== undefined && explicit !== null && String(explicit).trim()) {
      return String(explicit).trim();
    }
    return null;
  }
  return req.user?.location_id == null ? NO_LOCATION_SCOPE : String(req.user.location_id);
}

function writableLocation(req: AuthRequest): string | null {
  const location = requestedLocation(req);
  if (location === NO_LOCATION_SCOPE) {
    const error = new Error("A művelethez telephely-hozzárendelés szükséges.") as Error & { status?: number };
    error.status = 403;
    throw error;
  }
  return location;
}

function cleanModuleKey(value: unknown) {
  const key = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,100}$/.test(key)) {
    const error = new Error("Érvénytelen modulazonosító.") as Error & { status?: number };
    error.status = 400;
    throw error;
  }
  return key;
}

function plainObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function csvCell(value: unknown) {
  const text = value == null
    ? ""
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

async function definition(moduleKey: string) {
  const result = await pool.query(
    `SELECT module_key,title,category,route,description,entity_label,icon,
            fields,statuses,spec_reference,order_index
       FROM vir_module_definitions
      WHERE module_key=$1 AND is_active`,
    [moduleKey]
  );
  return result.rows[0] ?? null;
}

type ModulePermission =
  | "can_view"
  | "can_create"
  | "can_edit"
  | "can_delete"
  | "can_export";

type ModulePermissions = Record<ModulePermission, boolean>;

async function modulePermissions(req: AuthRequest, moduleRoute: string): Promise<ModulePermissions> {
  const roles = roleKeys(req.user?.role);
  if (roles.includes("admin")) {
    return { can_view: true, can_create: true, can_edit: true, can_delete: true, can_export: true };
  }
  if (!roles.length) {
    return { can_view: false, can_create: false, can_edit: false, can_delete: false, can_export: false };
  }

  const result = await pool.query(
    `SELECT
       COALESCE(bool_or(p.can_view),false) can_view,
       COALESCE(bool_or(p.can_create),false) can_create,
       COALESCE(bool_or(p.can_edit),false) can_edit,
       COALESCE(bool_or(p.can_delete),false) can_delete,
       COALESCE(bool_or(p.can_export),false) can_export
       FROM menus m
       LEFT JOIN role_menu_permissions p
         ON p.menu_id=m.id AND lower(p.role_key)=ANY($2::text[])
      WHERE lower(m.route)=lower($1) AND COALESCE(m.is_active,true)`,
    [moduleRoute, roles]
  );
  const row = result.rows[0] ?? {};
  return {
    can_view: Boolean(row.can_view),
    can_create: Boolean(row.can_create),
    can_edit: Boolean(row.can_edit),
    can_delete: Boolean(row.can_delete),
    can_export: Boolean(row.can_export),
  };
}

async function assertModulePermission(
  req: AuthRequest,
  moduleRoute: string,
  permission: ModulePermission
) {
  const permissions = await modulePermissions(req, moduleRoute);
  if (!permissions[permission]) {
    const error = new Error("Ehhez a művelethez nincs jogosultsága.") as Error & { status?: number };
    error.status = 403;
    throw error;
  }
}

async function audit(
  moduleKey: string,
  action: string,
  req: AuthRequest,
  recordId: string | null,
  beforeData: unknown,
  afterData: unknown,
  note?: string
) {
  await pool.query(
    `INSERT INTO vir_record_audit
       (record_id,module_key,action,actor_id,location_id,before_data,after_data,note)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [
      recordId,
      moduleKey,
      action,
      req.user?.id == null ? null : String(req.user.id),
      requestedLocation(req),
      beforeData == null ? null : JSON.stringify(beforeData),
      afterData == null ? null : JSON.stringify(afterData),
      note ?? null,
    ]
  );
}

router.use(requireAuth);

router.get(
  "/catalog",
  asyncRoute(async (req, res) => {
    await ensureVirSpecModules();
    const { rows } = await pool.query(
      `SELECT module_key,title,category,route,description,entity_label,icon,
              fields,statuses,spec_reference,order_index
         FROM vir_module_definitions
        WHERE is_active
        ORDER BY category,order_index,title`
    );
    const visible = [];
    for (const row of rows) {
      const permissions = await modulePermissions(req, row.route);
      if (permissions.can_view) visible.push({ ...row, permissions });
    }
    res.json(visible);
  })
);

router.get(
  "/resolve",
  asyncRoute(async (req, res) => {
    await ensureVirSpecModules();
    const route = String(req.query.route ?? "").trim();
    if (!route.startsWith("/")) {
      return res.status(400).json({ error: "Az útvonal megadása kötelező." });
    }

    let result = await pool.query(
      `SELECT module_key,title,category,route,description,entity_label,icon,
              fields,statuses,spec_reference,order_index
         FROM vir_module_definitions
        WHERE lower(route)=lower($1) AND is_active
        LIMIT 1`,
      [route]
    );

    if (!result.rows[0]) {
      const menu = await pool.query(
        `SELECT m.code,m.name,m.route,m.order_index,COALESCE(p.name,'Kleoszalon VIR') category
           FROM menus m
           LEFT JOIN menus p ON p.id=m.parent_id
          WHERE lower(m.route)=lower($1) AND COALESCE(m.is_active,true)
          LIMIT 1`,
        [route]
      );
      const item = menu.rows[0];
      if (item) {
        const moduleKey = String(item.code).replace(/\./g, "-").toLowerCase();
        await pool.query(
          `INSERT INTO vir_module_definitions
             (module_key,title,category,route,description,entity_label,fields,statuses,spec_reference,order_index)
           VALUES($1,$2,$3,$4,$5,'bejegyzés',$6::jsonb,$7::jsonb,'Kleoszalon VIR specifikáció',$8)
           ON CONFLICT(module_key) DO UPDATE SET
             title=EXCLUDED.title,category=EXCLUDED.category,route=EXCLUDED.route,
             is_active=true,updated_at=now()`,
          [
            moduleKey,
            item.name,
            item.category,
            item.route,
            "Adatbázis-alapú kezelőfelület kereséssel, státuszkezeléssel, naplózással és CSV-exporttal.",
            JSON.stringify([
              { key: "description", label: "Leírás", type: "textarea" },
              { key: "owner", label: "Felelős", type: "text" },
              { key: "effective_date", label: "Érvényesség / határidő", type: "date" },
            ]),
            JSON.stringify(["draft", "active", "closed", "archived"]),
            item.order_index ?? 100,
          ]
        );
        result = await pool.query(
          `SELECT module_key,title,category,route,description,entity_label,icon,
                  fields,statuses,spec_reference,order_index
             FROM vir_module_definitions
            WHERE module_key=$1`,
          [moduleKey]
        );
      }
    }

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Ehhez az oldalhoz még nincs moduldefiníció." });
    }
    const permissions = await modulePermissions(req, result.rows[0].route);
    if (!permissions.can_view) {
      const error = new Error("Ehhez a modulhoz nincs jogosultsága.") as Error & { status?: number };
      error.status = 403;
      throw error;
    }
    return res.json({ ...result.rows[0], permissions });
  })
);

router.get(
  "/:moduleKey/export",
  asyncRoute(async (req, res) => {
    await ensureVirSpecModules();
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    const moduleDefinition = await definition(moduleKey);
    if (!moduleDefinition) return res.status(404).json({ error: "A modul nem található." });
    await assertModulePermission(req, moduleDefinition.route, "can_export");
    const location = requestedLocation(req);
    const { rows } = await pool.query(
      `SELECT reference_no,title,status,priority,due_at,amount,currency,payload,created_at,updated_at
         FROM vir_module_records
        WHERE module_key=$1 AND is_active
          AND ($2::text IS NULL OR location_id IS NULL OR location_id=$2)
        ORDER BY updated_at DESC`,
      [moduleKey, location]
    );
    const headers = [
      "Azonosító",
      "Megnevezés",
      "Állapot",
      "Prioritás",
      "Határidő",
      "Összeg",
      "Deviza",
      "Részletes adatok",
      "Létrehozva",
      "Módosítva",
    ];
    const csv = [
      headers.map(csvCell).join(";"),
      ...rows.map((row) =>
        [
          row.reference_no,
          row.title,
          row.status,
          row.priority,
          row.due_at,
          row.amount,
          row.currency,
          row.payload,
          row.created_at,
          row.updated_at,
        ].map(csvCell).join(";")
      ),
    ].join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${moduleKey}-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    return res.send(`\uFEFF${csv}`);
  })
);

router.get(
  "/:moduleKey/records",
  asyncRoute(async (req, res) => {
    await ensureVirSpecModules();
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    const moduleDefinition = await definition(moduleKey);
    if (!moduleDefinition) return res.status(404).json({ error: "A modul nem található." });
    await assertModulePermission(req, moduleDefinition.route, "can_view");
    const location = requestedLocation(req);
    const query = String(req.query.q ?? "").trim();
    const status = String(req.query.status ?? "").trim();
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const { rows } = await pool.query(
      `SELECT id,module_key,location_id,title,reference_no,status,priority,due_at,
              amount,currency,payload,created_by,updated_by,created_at,updated_at
         FROM vir_module_records
        WHERE module_key=$1 AND is_active
          AND ($2::text IS NULL OR location_id IS NULL OR location_id=$2)
          AND ($3='' OR lower(title || ' ' || COALESCE(reference_no,'') || ' ' || payload::text)
                         LIKE '%' || lower($3) || '%')
          AND ($4='' OR status=$4)
        ORDER BY
          CASE priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'normal' THEN 3 ELSE 4 END,
          due_at NULLS LAST,updated_at DESC
        LIMIT $5 OFFSET $6`,
      [moduleKey, location, query, status, limit, offset]
    );
    const summary = await pool.query(
      `SELECT count(*)::int total,
              count(*) FILTER (WHERE status IN ('active','assigned','in_progress','new','registered','published','scheduled'))::int active,
              count(*) FILTER (WHERE due_at IS NOT NULL AND due_at<now() AND status NOT IN ('closed','approved','resolved','paid','archived','cancelled'))::int overdue,
              count(*) FILTER (WHERE updated_at::date=current_date)::int changed_today
         FROM vir_module_records
        WHERE module_key=$1 AND is_active
          AND ($2::text IS NULL OR location_id IS NULL OR location_id=$2)`,
      [moduleKey, location]
    );
    const permissions = await modulePermissions(req, moduleDefinition.route);
    return res.json({ definition: { ...moduleDefinition, permissions }, items: rows, summary: summary.rows[0] });
  })
);

router.get(
  "/:moduleKey/records/:id/audit",
  asyncRoute(async (req, res) => {
    await ensureVirSpecModules();
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    const moduleDefinition = await definition(moduleKey);
    if (!moduleDefinition) return res.status(404).json({ error: "A modul nem található." });
    await assertModulePermission(req, moduleDefinition.route, "can_view");
    const location = requestedLocation(req);
    const { rows } = await pool.query(
      `SELECT a.id,a.record_id,a.module_key,a.action,a.actor_id,a.location_id,
              a.before_data,a.after_data,a.note,a.created_at
         FROM vir_record_audit a
         JOIN vir_module_records r ON r.id=a.record_id
        WHERE a.module_key=$1 AND a.record_id=$2
          AND ($3::text IS NULL OR r.location_id IS NULL OR r.location_id=$3)
        ORDER BY a.created_at DESC
        LIMIT 200`,
      [moduleKey, req.params.id, location]
    );
    return res.json(rows);
  })
);

router.post(
  "/:moduleKey/records",
  asyncRoute(async (req, res) => {
    await ensureVirSpecModules();
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    const moduleDefinition = await definition(moduleKey);
    if (!moduleDefinition) return res.status(404).json({ error: "A modul nem található." });
    await assertModulePermission(req, moduleDefinition.route, "can_create");
    const body = plainObject(req.body);
    const title = String(body.title ?? "").trim();
    if (!title) return res.status(400).json({ error: "A megnevezés kötelező." });
    const allowedStatuses = Array.isArray(moduleDefinition.statuses)
      ? moduleDefinition.statuses.map(String)
      : [];
    const status = String(body.status ?? allowedStatuses[0] ?? "draft");
    if (allowedStatuses.length && !allowedStatuses.includes(status)) {
      return res.status(400).json({ error: "Érvénytelen állapot." });
    }
    const priority = String(body.priority ?? "normal");
    if (!["low", "normal", "high", "critical"].includes(priority)) {
      return res.status(400).json({ error: "Érvénytelen prioritás." });
    }
    const amount = body.amount === "" || body.amount == null ? null : Number(body.amount);
    if (amount !== null && !Number.isFinite(amount)) {
      return res.status(400).json({ error: "Az összeg csak szám lehet." });
    }
    const reference = String(body.reference_no ?? "").trim() ||
      `${moduleKey.slice(0, 5).toUpperCase()}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const location = writableLocation(req);
    const actor = req.user?.id == null ? null : String(req.user.id);
    const { rows } = await pool.query(
      `INSERT INTO vir_module_records
         (module_key,location_id,title,reference_no,status,priority,due_at,amount,currency,payload,created_by,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$11)
       RETURNING *`,
      [
        moduleKey,
        location,
        title,
        reference,
        status,
        priority,
        body.due_at || null,
        amount,
        String(body.currency ?? "HUF"),
        JSON.stringify(plainObject(body.payload)),
        actor,
      ]
    );
    await audit(moduleKey, "create", req, rows[0].id, null, rows[0]);
    return res.status(201).json(rows[0]);
  })
);

router.patch(
  "/:moduleKey/records/:id",
  asyncRoute(async (req, res) => {
    await ensureVirSpecModules();
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    const moduleDefinition = await definition(moduleKey);
    if (!moduleDefinition) return res.status(404).json({ error: "A modul nem található." });
    await assertModulePermission(req, moduleDefinition.route, "can_edit");
    const location = requestedLocation(req);
    const current = await pool.query(
      `SELECT * FROM vir_module_records
        WHERE id=$1 AND module_key=$2 AND is_active
          AND ($3::text IS NULL OR location_id IS NULL OR location_id=$3)`,
      [req.params.id, moduleKey, location]
    );
    if (!current.rows[0]) return res.status(404).json({ error: "A rekord nem található." });

    const body = plainObject(req.body);
    if (Object.prototype.hasOwnProperty.call(body, "title") && !String(body.title ?? "").trim()) {
      return res.status(400).json({ error: "A megnevezés kötelező." });
    }
    if (Object.prototype.hasOwnProperty.call(body, "status")) {
      const allowedStatuses = Array.isArray(moduleDefinition.statuses)
        ? moduleDefinition.statuses.map(String)
        : [];
      if (allowedStatuses.length && !allowedStatuses.includes(String(body.status))) {
        return res.status(400).json({ error: "Érvénytelen állapot." });
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "priority") &&
        !["low", "normal", "high", "critical"].includes(String(body.priority))) {
      return res.status(400).json({ error: "Érvénytelen prioritás." });
    }
    const setters: string[] = [];
    const values: unknown[] = [req.params.id, moduleKey];
    const columns: Record<string, string> = {
      title: "title",
      reference_no: "reference_no",
      status: "status",
      priority: "priority",
      due_at: "due_at",
      amount: "amount",
      currency: "currency",
    };
    if (isElevated(req)) columns.location_id = "location_id";
    for (const [key, column] of Object.entries(columns)) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        const raw = body[key];
        let value = raw === "" && ["due_at", "amount", "location_id", "reference_no"].includes(key)
          ? null
          : raw;
        if (key === "title") value = String(raw).trim();
        if (key === "amount" && value !== null) {
          value = Number(value);
          if (!Number.isFinite(value)) {
            return res.status(400).json({ error: "Az összeg csak szám lehet." });
          }
        }
        values.push(value);
        setters.push(`${column}=$${values.length}`);
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, "payload")) {
      values.push(JSON.stringify(plainObject(body.payload)));
      setters.push(`payload=$${values.length}::jsonb`);
    }
    if (!setters.length) return res.status(400).json({ error: "Nincs módosítandó adat." });
    values.push(req.user?.id == null ? null : String(req.user.id));
    setters.push(`updated_by=$${values.length}`, "updated_at=now()");

    const { rows } = await pool.query(
      `UPDATE vir_module_records SET ${setters.join(",")}
        WHERE id=$1 AND module_key=$2
        RETURNING *`,
      values
    );
    await audit(moduleKey, "update", req, rows[0].id, current.rows[0], rows[0]);
    return res.json(rows[0]);
  })
);

router.delete(
  "/:moduleKey/records/:id",
  asyncRoute(async (req, res) => {
    await ensureVirSpecModules();
    const moduleKey = cleanModuleKey(req.params.moduleKey);
    const moduleDefinition = await definition(moduleKey);
    if (!moduleDefinition) return res.status(404).json({ error: "A modul nem található." });
    await assertModulePermission(req, moduleDefinition.route, "can_delete");
    const location = requestedLocation(req);
    const current = await pool.query(
      `SELECT * FROM vir_module_records
        WHERE id=$1 AND module_key=$2 AND is_active
          AND ($3::text IS NULL OR location_id IS NULL OR location_id=$3)`,
      [req.params.id, moduleKey, location]
    );
    if (!current.rows[0]) return res.status(404).json({ error: "A rekord nem található." });
    const reason = String(req.body?.reason ?? "").trim();
    const { rows } = await pool.query(
      `UPDATE vir_module_records
          SET is_active=false,updated_by=$3,updated_at=now(),
              payload=payload || jsonb_build_object('deactivation_reason',$4::text)
        WHERE id=$1 AND module_key=$2
        RETURNING *`,
      [
        req.params.id,
        moduleKey,
        req.user?.id == null ? null : String(req.user.id),
        reason || "Felhasználói inaktiválás",
      ]
    );
    await audit(moduleKey, "deactivate", req, rows[0].id, current.rows[0], rows[0], reason);
    return res.json({ ok: true, item: rows[0] });
  })
);

export default router;
