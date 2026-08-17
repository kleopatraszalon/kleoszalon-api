import { Router } from "express";
import db from "../db";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireAdmin, requireManagement } from "../middleware/requireRoles";
import {
  alertRuleSummary,
  collectRuleDrivenAlerts,
  listAlertDeliveryLog,
  listAlertRules,
  removeAlertRuleOverride,
  retryAlertDelivery,
  runAlertRuleAutomation,
  upsertAlertRule,
} from "../services/alertRuleEngine";
import {
  collectMaintenanceAlerts,
  listMaintenanceCatalog,
  MAINTENANCE_RULE_KEY,
  maintenanceSummary,
  removeMaintenanceRuleOverride,
  runMaintenanceAlertAutomation,
  upsertMaintenanceRule,
} from "../compliance/pdfGreenCompliance";

const router = Router();
router.use(requireAuth);
const userKey=(req:AuthRequest)=>req.user?.email?`email:${String(req.user.email).toLowerCase()}`:`user:${String(req.user?.id??"unknown")}`;

router.get("/rules", requireManagement, async (_req, res, next) => {
  try {
    const [base,maintenance]=await Promise.all([listAlertRules(),listMaintenanceCatalog()]);
    res.json({...base,catalog:[...(base.catalog||[]),...(maintenance.catalog||[])]});
  } catch (error) { next(error); }
});
router.put("/rules/:ruleKey", requireAdmin, async (req: any, res, next) => {
  try {
    res.json(req.params.ruleKey===MAINTENANCE_RULE_KEY
      ? await upsertMaintenanceRule(req.body||{},req.user)
      : await upsertAlertRule(req.params.ruleKey,req.body||{},req.user));
  } catch (error) { next(error); }
});
router.delete("/rules/:ruleKey", requireAdmin, async (req: any, res, next) => {
  try {
    res.json(req.params.ruleKey===MAINTENANCE_RULE_KEY
      ? await removeMaintenanceRuleOverride(String(req.query.scope_id||""),req.user)
      : await removeAlertRuleOverride(req.params.ruleKey,String(req.query.scope_id||""),req.user));
  } catch (error) { next(error); }
});
router.get("/deliveries", requireManagement, async (req: any, res, next) => {
  try { res.json(await listAlertDeliveryLog(req.user?.location_id || req.query.location_id, req.query.limit, req.query.status, req.query.channel)); } catch (error) { next(error); }
});
router.post("/deliveries/:id/retry", requireAdmin, async (req, res, next) => {
  try { res.json(await retryAlertDelivery(req.params.id)); } catch (error) { next(error); }
});
router.get("/summary", requireManagement, async (req: any, res, next) => {
  try {
    const location=req.user?.location_id||req.query.location_id;
    res.json({...await alertRuleSummary(location),...await maintenanceSummary(location)});
  } catch (error) { next(error); }
});
router.get("/items", async (req: AuthRequest, res, next) => {
  try {
    const locationId=req.user?.location_id==null?null:String(req.user.location_id);
    const [base,maintenance,state]=await Promise.all([
      collectRuleDrivenAlerts(locationId),
      collectMaintenanceAlerts(locationId),
      db.query(`SELECT notification_key,read_at,dismissed_at FROM notification_read_state WHERE user_key=$1`,[userKey(req)]),
    ]);
    const states=new Map(state.rows.map((x:any)=>[String(x.notification_key),x]));
    const alerts=[...base,...maintenance].sort((a,b)=>{
      if(a.severity!==b.severity)return a.severity==="critical"?-1:1;
      return +new Date(a.due_at||a.created_at)-+new Date(b.due_at||b.created_at);
    });
    const items=alerts.filter(x=>!states.get(x.key)?.dismissed_at).map(x=>({...x,read:Boolean(states.get(x.key)?.read_at)}));
    res.json({items});
  } catch (error) { next(error); }
});
router.post("/run", requireManagement, async (_req, res, next) => {
  try {
    const [base,maintenance]=await Promise.all([runAlertRuleAutomation(),runMaintenanceAlertAutomation()]);
    res.json({ok:true,...base,maintenance});
  } catch (error) { next(error); }
});

export default router;
