import { NextFunction, Request, Response, Router } from "express";
import pool from "../db";
import { ensureHrV2 } from "../hr/ensureHrV2";
import { AuthRequest, requireAuth } from "../middleware/auth";
import { SPEC_MODULE_CATALOG } from "../vir/specCatalog";

const router = Router();
router.use(requireAuth);

const asyncRoute = (handler: (req: AuthRequest, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) =>
    handler(req as AuthRequest, res).catch(next);

const directColumns = new Set([
  "title", "description", "status", "priority", "location_id", "department_id",
  "employee_id", "client_id", "partner_id", "parent_id", "direction", "amount",
  "currency", "quantity", "unit", "start_at", "due_at", "completed_at", "is_active",
]);

function rolesOf(req: AuthRequest) {
  const raw: unknown = req.user?.role;
  if (Array.isArray(raw)) return raw.map(String).map((x) => x.toLowerCase());
  try {
    const parsed = JSON.parse(String(raw || ""));
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String).map((x) => x.toLowerCase());
  } catch {
    return String(raw || "")
      .split(",")
      .map((x) => x.replace(/[\[\]"]/g, "").trim().toLowerCase())
      .filter(Boolean);
  }
}

function isAdminOrManager(req: AuthRequest) {
  const roles = rolesOf(req);
  return roles.includes("admin") || roles.includes("manager");
}

type MenuPermission = "can_view" | "can_create" | "can_edit" | "can_delete" | "can_approve" | "can_export";

async function hasRoutePermission(req: AuthRequest, routes: string[], permission: MenuPermission) {
  if (isAdminOrManager(req) && rolesOf(req).includes("admin")) return true;
  const roles = rolesOf(req);
  if (!roles.length || !routes.length) return false;
  const { rows } = await pool.query(
    `SELECT COALESCE(bool_or(p.${permission}),false) allowed
     FROM role_menu_permissions p
     JOIN menus m ON m.id=p.menu_id
     WHERE lower(p.role_key)=ANY($1::text[])
       AND m.route=ANY($2::text[])
       AND COALESCE(m.is_active,true)`,
    [roles, routes]
  );
  return Boolean(rows[0]?.allowed);
}

async function requireRoutePermission(
  req: AuthRequest,
  res: Response,
  routes: string[],
  permission: MenuPermission
) {
  if (await hasRoutePermission(req, routes, permission)) return true;
  res.status(403).json({ error: "Ehhez a művelethez nincs jogosultsága." });
  return false;
}

function routesForModule(moduleKey: string) {
  return Array.from(new Set(
    SPEC_MODULE_CATALOG
      .filter((item) => item.module_key === moduleKey)
      .map((item) => item.route)
  ));
}

function userId(req: AuthRequest) {
  return req.user?.id == null ? null : String(req.user.id);
}

function userLocation(req: AuthRequest) {
  return req.user?.location_id == null ? null : String(req.user.location_id);
}

function normalizeModuleKey(value: unknown) {
  const key = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,79}$/.test(key)) return null;
  return key;
}

function nullable(value: unknown) {
  return value === "" || value === undefined ? null : value;
}

function customData(body: Record<string, unknown>) {
  const extra: Record<string, unknown> = {
    ...(body.data && typeof body.data === "object" && !Array.isArray(body.data)
      ? body.data as Record<string, unknown>
      : {}),
  };
  for (const [key, value] of Object.entries(body)) {
    if (!directColumns.has(key) && key !== "data" && key !== "module_key" && key !== "record_no") {
      extra[key] = value;
    }
  }
  return extra;
}

function scopedLocation(req: AuthRequest, requested: unknown) {
  if (isAdminOrManager(req)) return nullable(requested) || null;
  return userLocation(req);
}

async function history(
  recordId: string,
  action: string,
  req: AuthRequest,
  oldData: unknown,
  newData: unknown
) {
  await pool.query(
    `INSERT INTO vir_record_history(record_id,action,actor_user_id,actor_role,old_data,new_data)
     VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [recordId, action, userId(req), String(req.user?.role || ""), JSON.stringify(oldData ?? null), JSON.stringify(newData ?? null)]
  );
}

router.get("/catalog", asyncRoute(async (_req, res) => {
  await ensureHrV2();
  res.json({
    version: "20260806_VIR_SPEC_ALIGNMENT_V1",
    modules: SPEC_MODULE_CATALOG,
    brand: {
      colors: ["#120c08", "#b69861", "#c8b187", "#ec008c", "#ffffff"],
      heading_font: "Montserrat",
      body_font: "Open Sans",
    },
  });
}));

router.get("/summary", asyncRoute(async (req, res) => {
  await ensureHrV2();
  if (!isAdminOrManager(req)) return res.status(403).json({ error: "A vezetői összesítéshez nincs jogosultsága." });
  const location = scopedLocation(req, req.query.location_id);
  const { rows } = await pool.query(
    `SELECT module_key,
            COUNT(*) FILTER (WHERE is_active)::int total,
            COUNT(*) FILTER (WHERE is_active AND status IN ('open','new','pending','submitted','in_progress','investigating','pending_moderation'))::int open_count,
            COUNT(*) FILTER (WHERE is_active AND due_at IS NOT NULL AND due_at < now() AND status NOT IN ('completed','approved','paid','posted','received','resolved','closed','cancelled'))::int overdue_count,
            COALESCE(SUM(amount) FILTER (WHERE is_active),0)::numeric total_amount,
            MAX(updated_at) last_updated_at
     FROM vir_module_records
     WHERE ($1::uuid IS NULL OR location_id=$1)
     GROUP BY module_key ORDER BY module_key`,
    [location]
  );
  res.json(rows);
}));

router.get("/knowledge/articles", asyncRoute(async (req, res) => {
  await ensureHrV2();
  if (!await requireRoutePermission(req, res, ["/knowledge/articles"], "can_view")) return;
  const query = String(req.query.search || "").trim();
  const location = scopedLocation(req, req.query.location_id);
  const { rows } = await pool.query(
    `SELECT * FROM vir_knowledge_articles
     WHERE is_active
       AND ($1='' OR title ILIKE '%'||$1||'%' OR summary ILIKE '%'||$1||'%' OR content ILIKE '%'||$1||'%' OR array_to_string(tags,' ') ILIKE '%'||$1||'%')
       AND ($2::uuid IS NULL OR location_id IS NULL OR location_id=$2)
     ORDER BY CASE status WHEN 'published' THEN 0 ELSE 1 END, category, title`,
    [query, location]
  );
  res.json(rows);
}));

router.post("/knowledge/articles", asyncRoute(async (req, res) => {
  await ensureHrV2();
  if (!await requireRoutePermission(req, res, ["/knowledge/articles"], "can_create")) return;
  const body = req.body || {};
  const title = String(body.title || "").trim();
  const content = String(body.content || "").trim();
  if (!title || !content) return res.status(400).json({ error: "A cím és a tartalom kötelező." });
  const baseSlug = String(body.slug || title)
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "cikk";
  const slug = `${baseSlug}-${Date.now().toString(36)}`;
  const { rows } = await pool.query(
    `INSERT INTO vir_knowledge_articles(title,slug,summary,content,category,tags,status,visibility,location_id,source_url,created_by,updated_by)
     VALUES($1,$2,$3,$4,COALESCE($5,'Általános'),$6::text[],COALESCE($7,'draft'),COALESCE($8,'internal'),$9,$10,$11,$11)
     RETURNING *`,
    [title, slug, nullable(body.summary), content, nullable(body.category), Array.isArray(body.tags) ? body.tags.map(String) : [], body.status, body.visibility, scopedLocation(req, body.location_id), nullable(body.source_url), userId(req)]
  );
  res.status(201).json(rows[0]);
}));

router.patch("/knowledge/articles/:id", asyncRoute(async (req, res) => {
  await ensureHrV2();
  if (!await requireRoutePermission(req, res, ["/knowledge/articles"], "can_edit")) return;
  const body = req.body || {};
  const allowed = ["title", "summary", "content", "category", "tags", "status", "visibility", "source_url", "ai_summary", "is_active"];
  const sets: string[] = [];
  const values: unknown[] = [req.params.id];
  for (const key of allowed) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    values.push(key === "tags" ? (Array.isArray(body[key]) ? body[key].map(String) : []) : nullable(body[key]));
    sets.push(`${key}=$${values.length}${key === "tags" ? "::text[]" : ""}`);
  }
  if (!sets.length) return res.status(400).json({ error: "Nincs módosítandó adat." });
  values.push(userId(req));
  const { rows } = await pool.query(
    `UPDATE vir_knowledge_articles SET ${sets.join(",")},updated_by=$${values.length},updated_at=now(),version=version+1
     WHERE id=$1 RETURNING *`,
    values
  );
  if (!rows[0]) return res.status(404).json({ error: "A tudásbáziscikk nem található." });
  res.json(rows[0]);
}));

router.get("/conversations", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const conversationType = String(req.query.type || "").trim();
  if (conversationType && !["internal", "ai"].includes(conversationType)) {
    return res.status(400).json({ error: "Érvénytelen beszélgetéstípus." });
  }
  const routes = conversationType === "ai"
    ? ["/knowledge/assistant"]
    : conversationType === "internal"
      ? ["/operations/chat"]
      : ["/operations/chat", "/knowledge/assistant"];
  if (!await requireRoutePermission(req, res, routes, "can_view")) return;
  const location = scopedLocation(req, req.query.location_id);
  const { rows } = await pool.query(
    `SELECT c.*,
            (SELECT content FROM vir_messages m WHERE m.conversation_id=c.id ORDER BY created_at DESC LIMIT 1) last_message,
            (SELECT COUNT(*)::int FROM vir_messages m WHERE m.conversation_id=c.id) message_count
     FROM vir_conversations c
     WHERE c.is_active
       AND ($1::uuid IS NULL OR c.location_id IS NULL OR c.location_id=$1)
       AND ($2='' OR c.conversation_type=$2)
     ORDER BY c.updated_at DESC`,
    [location, conversationType]
  );
  res.json(rows);
}));

router.post("/conversations", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const body = req.body || {};
  const title = String(body.title || "Új beszélgetés").trim();
  const kind = String(body.conversation_type || "internal");
  if (!["internal", "ai"].includes(kind)) return res.status(400).json({ error: "Érvénytelen beszélgetéstípus." });
  const route = kind === "ai" ? "/knowledge/assistant" : "/operations/chat";
  if (!await requireRoutePermission(req, res, [route], "can_create")) return;
  const { rows } = await pool.query(
    `INSERT INTO vir_conversations(title,conversation_type,location_id,created_by)
     VALUES($1,$2,$3,$4) RETURNING *`,
    [title, kind, scopedLocation(req, body.location_id) || userLocation(req), userId(req)]
  );
  res.status(201).json(rows[0]);
}));

router.get("/conversations/:id/messages", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const location = scopedLocation(req, req.query.location_id);
  const conversation = await pool.query(
    `SELECT conversation_type FROM vir_conversations
     WHERE id=$1 AND is_active AND ($2::uuid IS NULL OR location_id IS NULL OR location_id=$2)`,
    [req.params.id, location]
  );
  if (!conversation.rows[0]) return res.status(404).json({ error: "A beszélgetés nem található." });
  const route = conversation.rows[0].conversation_type === "ai" ? "/knowledge/assistant" : "/operations/chat";
  if (!await requireRoutePermission(req, res, [route], "can_view")) return;
  const { rows } = await pool.query(
    `SELECT m.* FROM vir_messages m
     JOIN vir_conversations c ON c.id=m.conversation_id
     WHERE m.conversation_id=$1 AND c.is_active AND ($2::uuid IS NULL OR c.location_id IS NULL OR c.location_id=$2)
     ORDER BY m.created_at`,
    [req.params.id, location]
  );
  res.json(rows);
}));

router.post("/conversations/:id/messages", asyncRoute(async (req, res) => {
  await ensureHrV2();
  if (!await requireRoutePermission(req, res, ["/operations/chat"], "can_create")) return;
  const content = String(req.body?.content || "").trim();
  if (!content) return res.status(400).json({ error: "Az üzenet nem lehet üres." });
  const location = scopedLocation(req, req.body?.location_id);
  const allowed = await pool.query(
    `SELECT id FROM vir_conversations WHERE id=$1 AND is_active AND conversation_type='internal'
     AND ($2::uuid IS NULL OR location_id IS NULL OR location_id=$2)`,
    [req.params.id, location]
  );
  if (!allowed.rows[0]) return res.status(404).json({ error: "A beszélgetés nem található." });
  const { rows } = await pool.query(
    `INSERT INTO vir_messages(conversation_id,sender_type,sender_user_id,content)
     VALUES($1,'user',$2,$3) RETURNING *`,
    [req.params.id, userId(req), content]
  );
  await pool.query("UPDATE vir_conversations SET updated_at=now() WHERE id=$1", [req.params.id]);
  res.status(201).json(rows[0]);
}));

function extractOpenAIText(payload: any) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) return payload.output_text.trim();
  const parts: string[] = [];
  for (const item of Array.isArray(payload?.output) ? payload.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

router.post("/assistant", asyncRoute(async (req, res) => {
  await ensureHrV2();
  if (!await requireRoutePermission(req, res, ["/knowledge/assistant"], "can_create")) return;
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Írjon kérdést az asszisztensnek." });

  let conversationId = String(req.body?.conversation_id || "").trim();
  const location = scopedLocation(req, req.body?.location_id) || userLocation(req);
  if (conversationId) {
    const existing = await pool.query(
      `SELECT id FROM vir_conversations WHERE id=$1 AND is_active AND conversation_type='ai'
       AND ($2::uuid IS NULL OR location_id IS NULL OR location_id=$2)`,
      [conversationId, location]
    );
    if (!existing.rows[0]) return res.status(404).json({ error: "Az AI-beszélgetés nem található." });
  } else {
    const created = await pool.query(
      `INSERT INTO vir_conversations(title,conversation_type,location_id,created_by)
       VALUES($1,'ai',$2,$3) RETURNING id`,
      [message.slice(0, 80), location, userId(req)]
    );
    conversationId = created.rows[0].id;
  }

  await pool.query(
    `INSERT INTO vir_messages(conversation_id,sender_type,sender_user_id,content)
     VALUES($1,'user',$2,$3)`,
    [conversationId, userId(req), message]
  );

  const articles = await pool.query(
    `SELECT id,title,slug,summary,content,category
     FROM vir_knowledge_articles
     WHERE is_active AND status='published'
       AND ($2::uuid IS NULL OR location_id IS NULL OR location_id=$2)
     ORDER BY ts_rank(
       to_tsvector('simple',title||' '||COALESCE(summary,'')||' '||content),
       plainto_tsquery('simple',$1)
     ) DESC, updated_at DESC
     LIMIT 6`,
    [message, location]
  );
  const sources = articles.rows.map((article) => ({ id: article.id, title: article.title, slug: article.slug, category: article.category }));
  const context = articles.rows
    .map((article, index) => `[${index + 1}] ${article.title}\n${article.summary || ""}\n${String(article.content).slice(0, 2400)}`)
    .join("\n\n");

  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  let answer: string;
  let aiConfigured = Boolean(apiKey);
  let model: string | null = null;

  if (!apiKey) {
    answer = sources.length
      ? `Az AI szolgáltatás még nincs konfigurálva, de a tudásbázisban ${sources.length} kapcsolódó anyagot találtam: ${sources.map((source) => source.title).join(", ")}. Az AI-válaszhoz állítsa be a Render backend OPENAI_API_KEY környezeti változóját.`
      : "Az AI szolgáltatás még nincs konfigurálva. Állítsa be a Render backend OPENAI_API_KEY környezeti változóját; közben a tudásbázis keresője továbbra is használható.";
  } else {
    model = String(process.env.OPENAI_MODEL || "gpt-5.6-terra");
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        max_output_tokens: 1200,
        instructions: "Te a Kleopátra Szépségszalonok belső VIR asszisztense vagy. Magyarul, tömören és gyakorlatiasan válaszolj. Elsősorban a mellékelt belső tudásbázist használd. Ha a források nem tartalmazzák a választ, ezt egyértelműen jelezd; ne találj ki céges szabályt, jogi vagy pénzügyi tényt.",
        input: `BELSŐ TUDÁSBÁZIS:\n${context || "Nincs kapcsolódó cikk."}\n\nFELHASZNÁLÓ KÉRDÉSE:\n${message}`,
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("OpenAI Responses API hiba", response.status, payload?.error?.message || "ismeretlen hiba");
      return res.status(502).json({ error: "Az AI-szolgáltatás most nem elérhető.", detail: payload?.error?.message || null, conversation_id: conversationId });
    }
    answer = extractOpenAIText(payload) || "Az AI nem adott szöveges választ.";
  }

  const inserted = await pool.query(
    `INSERT INTO vir_messages(conversation_id,sender_type,content,metadata)
     VALUES($1,'assistant',$2,$3::jsonb) RETURNING *`,
    [conversationId, answer, JSON.stringify({ ai_configured: aiConfigured, model, sources })]
  );
  await pool.query("UPDATE vir_conversations SET updated_at=now() WHERE id=$1", [conversationId]);
  res.json({ conversation_id: conversationId, message: inserted.rows[0], answer, sources, ai_configured: aiConfigured, model });
}));

router.get("/:moduleKey", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const moduleKey = normalizeModuleKey(req.params.moduleKey);
  if (!moduleKey) return res.status(400).json({ error: "Érvénytelen modulazonosító." });
  if (!await requireRoutePermission(req, res, routesForModule(moduleKey), "can_view")) return;
  const search = String(req.query.search || "").trim();
  const status = String(req.query.status || "").trim();
  const includeInactive = req.query.include_inactive === "1" || req.query.include_inactive === "true";
  const location = scopedLocation(req, req.query.location_id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 250);
  const { rows } = await pool.query(
    `SELECT r.*,l.name location_name,e.full_name employee_name
     FROM vir_module_records r
     LEFT JOIN locations l ON l.id=r.location_id
     LEFT JOIN employees e ON e.id=r.employee_id
     WHERE r.module_key=$1
       AND ($2 OR r.is_active)
       AND ($3='' OR r.status=$3)
       AND ($4='' OR r.record_no ILIKE '%'||$4||'%' OR r.title ILIKE '%'||$4||'%' OR r.description ILIKE '%'||$4||'%' OR r.data::text ILIKE '%'||$4||'%')
       AND ($5::uuid IS NULL OR r.location_id IS NULL OR r.location_id=$5)
     ORDER BY r.is_active DESC,r.updated_at DESC LIMIT $6`,
    [moduleKey, includeInactive, status, search, location, limit]
  );
  res.json(rows);
}));

router.post("/:moduleKey", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const moduleKey = normalizeModuleKey(req.params.moduleKey);
  if (!moduleKey) return res.status(400).json({ error: "Érvénytelen modulazonosító." });
  if (!await requireRoutePermission(req, res, routesForModule(moduleKey), "can_create")) return;
  const body = req.body || {};
  const title = String(body.title || "").trim();
  if (!title) return res.status(400).json({ error: "A megnevezés kötelező." });
  const extra = customData(body);
  const { rows } = await pool.query(
    `INSERT INTO vir_module_records(
       module_key,title,description,status,priority,location_id,department_id,employee_id,client_id,partner_id,parent_id,
       direction,amount,currency,quantity,unit,start_at,due_at,completed_at,data,is_active,created_by,updated_by
     ) VALUES(
       $1,$2,$3,COALESCE($4,'draft'),COALESCE($5,'normal'),$6,$7,$8,$9,$10,$11,
       $12,$13,COALESCE($14,'HUF'),$15,$16,$17,$18,$19,$20::jsonb,COALESCE($21,true),$22,$22
     ) RETURNING *`,
    [moduleKey,title,nullable(body.description),nullable(body.status),nullable(body.priority),scopedLocation(req, body.location_id) || userLocation(req),nullable(body.department_id),nullable(body.employee_id),nullable(body.client_id),nullable(body.partner_id),nullable(body.parent_id),nullable(body.direction),nullable(body.amount),nullable(body.currency),nullable(body.quantity),nullable(body.unit),nullable(body.start_at),nullable(body.due_at),nullable(body.completed_at),JSON.stringify(extra),body.is_active,userId(req)]
  );
  await history(rows[0].id, "create", req, null, rows[0]);
  res.status(201).json(rows[0]);
}));

router.patch("/:moduleKey/:id", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const moduleKey = normalizeModuleKey(req.params.moduleKey);
  if (!moduleKey) return res.status(400).json({ error: "Érvénytelen modulazonosító." });
  if (!await requireRoutePermission(req, res, routesForModule(moduleKey), "can_edit")) return;
  const location = scopedLocation(req, req.body?.location_id);
  const existing = await pool.query(
    `SELECT * FROM vir_module_records WHERE id=$1 AND module_key=$2
     AND ($3::uuid IS NULL OR location_id IS NULL OR location_id=$3)`,
    [req.params.id, moduleKey, location]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: "A rekord nem található." });

  const body = req.body || {};
  const sets: string[] = [];
  const values: unknown[] = [req.params.id, moduleKey];
  for (const column of directColumns) {
    if (!Object.prototype.hasOwnProperty.call(body, column)) continue;
    if (column === "location_id" && !isAdminOrManager(req)) continue;
    values.push(nullable(body[column]));
    sets.push(`${column}=$${values.length}`);
  }
  const extra = customData(body);
  if (Object.keys(extra).length) {
    values.push(JSON.stringify(extra));
    sets.push(`data=data||$${values.length}::jsonb`);
  }
  if (!sets.length) return res.status(400).json({ error: "Nincs módosítandó adat." });
  values.push(userId(req));
  sets.push(`updated_by=$${values.length}`, "updated_at=now()");
  const { rows } = await pool.query(
    `UPDATE vir_module_records SET ${sets.join(",")}
     WHERE id=$1 AND module_key=$2 RETURNING *`,
    values
  );
  await history(rows[0].id, "update", req, existing.rows[0], rows[0]);
  res.json(rows[0]);
}));

router.delete("/:moduleKey/:id", asyncRoute(async (req, res) => {
  await ensureHrV2();
  const moduleKey = normalizeModuleKey(req.params.moduleKey);
  if (!moduleKey) return res.status(400).json({ error: "Érvénytelen modulazonosító." });
  if (!await requireRoutePermission(req, res, routesForModule(moduleKey), "can_delete")) return;
  const location = scopedLocation(req, req.query.location_id);
  const existing = await pool.query(
    `SELECT * FROM vir_module_records WHERE id=$1 AND module_key=$2
     AND ($3::uuid IS NULL OR location_id IS NULL OR location_id=$3)`,
    [req.params.id, moduleKey, location]
  );
  if (!existing.rows[0]) return res.status(404).json({ error: "A rekord nem található." });
  const { rows } = await pool.query(
    `UPDATE vir_module_records SET is_active=false,status='cancelled',updated_by=$3,updated_at=now()
     WHERE id=$1 AND module_key=$2 RETURNING *`,
    [req.params.id, moduleKey, userId(req)]
  );
  await history(rows[0].id, "deactivate", req, existing.rows[0], rows[0]);
  res.json({ success: true, record: rows[0] });
}));

export default router;
