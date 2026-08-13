import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireAdmin, requireManagement } from "../middleware/requireRoles";
import {
  alertRuleSummary,
  listAlertDeliveryLog,
  listAlertRules,
  removeAlertRuleOverride,
  retryAlertDelivery,
  runAlertRuleAutomation,
  upsertAlertRule,
} from "../services/alertRuleEngine";

const router = Router();
router.use(requireAuth);

router.get("/rules", requireManagement, async (_req, res, next) => {
  try { res.json(await listAlertRules()); } catch (error) { next(error); }
});
router.put("/rules/:ruleKey", requireAdmin, async (req: any, res, next) => {
  try { res.json(await upsertAlertRule(req.params.ruleKey, req.body || {}, req.user)); } catch (error) { next(error); }
});
router.delete("/rules/:ruleKey", requireAdmin, async (req: any, res, next) => {
  try { res.json(await removeAlertRuleOverride(req.params.ruleKey, String(req.query.scope_id || ""), req.user)); } catch (error) { next(error); }
});
router.get("/deliveries", requireManagement, async (req: any, res, next) => {
  try { res.json(await listAlertDeliveryLog(req.user?.location_id || req.query.location_id, req.query.limit, req.query.status, req.query.channel)); } catch (error) { next(error); }
});
router.post("/deliveries/:id/retry", requireAdmin, async (req, res, next) => {
  try { res.json(await retryAlertDelivery(req.params.id)); } catch (error) { next(error); }
});
router.get("/summary", requireManagement, async (req: any, res, next) => {
  try { res.json(await alertRuleSummary(req.user?.location_id || req.query.location_id)); } catch (error) { next(error); }
});
router.post("/run", requireManagement, async (_req, res, next) => {
  try { res.json({ ok: true, ...(await runAlertRuleAutomation()) }); } catch (error) { next(error); }
});

export default router;
