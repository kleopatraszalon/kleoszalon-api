import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { requireFeature } from "../middleware/featureAccess";
import { requireMenuPermission } from "../middleware/menuPermission";
import { ensureSystemAuditSchema } from "../audit/systemAudit";

const router = Router();
router.use(requireAuth);
router.use(requireFeature("audit"));
router.use(async (_req, _res, next) => {
  try {
    await ensureSystemAuditSchema();
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/summary", requireMenuPermission("settings.audit", "can_view"), async (_req, res, next) => {
  try {
    const { rows } = await db.query(`SELECT
      COUNT(*) FILTER (WHERE occurred_at >= CURRENT_DATE)::int today,
      COUNT(*) FILTER (WHERE occurred_at >= now()-interval '7 days')::int last_7_days,
      COUNT(*) FILTER (WHERE action IN ('delete','soft_delete','deactivate'))::int deletes,
      COUNT(*) FILTER (WHERE action='restore')::int restores,
      COUNT(*) FILTER (WHERE severity IN ('error','critical'))::int errors,
      COUNT(*) FILTER (WHERE module_key='finance')::int finance_events,
      COUNT(*) FILTER (WHERE module_key='inventory')::int inventory_events,
      COUNT(*) FILTER (WHERE module_key='hr')::int hr_events,
      COUNT(*) FILTER (WHERE module_key='administration')::int admin_events,
      COUNT(*) FILTER (WHERE module_key='crm')::int crm_events
      FROM system_audit_log`);
    res.json(rows[0] || {});
  } catch (err) { next(err); }
});

function filters(req: AuthRequest) {
  const q = String(req.query.q || "").trim();
  const moduleKey = String(req.query.module || "").trim();
  const action = String(req.query.action || "").trim();
  const severity = String(req.query.severity || "").trim();
  const from = String(req.query.from || "").trim();
  const to = String(req.query.to || "").trim();
  const locationId = String(req.query.location_id || "").trim();
  const actor = String(req.query.actor || "").trim();
  const entityType = String(req.query.entity_type || "").trim();
  const params:any[]=[]; const where:string[]=[];
  const add=(sql:string,v:any)=>{params.push(v);where.push(sql.replace("?",`$${params.length}`));};
  if(q){ params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`); const b=params.length-4; where.push(`(COALESCE(actor_key,'') ILIKE $${b} OR COALESCE(actor_name,'') ILIKE $${b+1} OR COALESCE(summary,'') ILIKE $${b+2} OR COALESCE(entity_type,'') ILIKE $${b+3} OR COALESCE(entity_id,'') ILIKE $${b+4})`); }
  if(moduleKey) add(`module_key=?`,moduleKey);
  if(action) add(`action=?`,action);
  if(severity) add(`severity=?`,severity);
  if(from) add(`occurred_at::date>=?::date`,from);
  if(to) add(`occurred_at::date<=?::date`,to);
  if(locationId) add(`location_id=?`,locationId);
  if(actor){params.push(`%${actor}%`);where.push(`(COALESCE(actor_key,'') ILIKE $${params.length} OR COALESCE(actor_name,'') ILIKE $${params.length})`);}
  if(entityType) add(`entity_type=?`,entityType);
  return { params, where };
}

router.get("/export.csv", requireMenuPermission("settings.audit", "can_export"), async (req: AuthRequest, res, next) => {
  try {
    const { params, where } = filters(req);
    const { rows } = await db.query(`SELECT occurred_at,actor_key,actor_name,location_id,module_key,entity_type,entity_id,action,severity,summary
      FROM system_audit_log ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY occurred_at DESC LIMIT 5000`,params);
    const esc=(v:any)=>`"${String(v??"").replace(/"/g,'""')}"`;
    const header=["occurred_at","actor_key","actor_name","location_id","module_key","entity_type","entity_id","action","severity","summary"];
    const csv=[header.join(";"),...rows.map((r:any)=>header.map(k=>esc(r[k])).join(";"))].join("\n");
    res.setHeader("Content-Type","text/csv; charset=utf-8");
    res.setHeader("Content-Disposition",`attachment; filename="kleoszalon-audit-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(`\uFEFF${csv}`);
  } catch (err) { next(err); }
});

router.get("/", requireMenuPermission("settings.audit", "can_view"), async (req: AuthRequest, res, next) => {
  try {
    const limit = Math.min(500, Math.max(20, Number(req.query.limit || 150)));
    const { params, where } = filters(req);
    params.push(limit);
    const { rows } = await db.query(`SELECT id,occurred_at,actor_key,actor_name,location_id,module_key,entity_type,entity_id,action,severity,summary,before_data,after_data,metadata
      FROM system_audit_log ${where.length?`WHERE ${where.join(' AND ')}`:''} ORDER BY occurred_at DESC LIMIT $${params.length}`,params);
    res.json(rows);
  } catch (err) { next(err); }
});

export default router;
