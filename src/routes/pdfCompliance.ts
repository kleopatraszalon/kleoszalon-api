import { Router } from "express";
import { requireAuth, type AuthRequest } from "../middleware/auth";
import { requireManagement } from "../middleware/requireRoles";
import {
  listUiAuditEvents,
  maintenanceSummary,
  recordUiAuditEvents,
  runPdfGreenAutomation,
} from "../compliance/pdfGreenCompliance";

const router = Router();
router.use(requireAuth);

router.post("/ui-audit", async (req: AuthRequest, res, next) => {
  try {
    res.status(202).json(await recordUiAuditEvents(req, req.body?.events));
  } catch (error) { next(error); }
});

router.get("/ui-audit", requireManagement, async (req, res, next) => {
  try { res.json(await listUiAuditEvents(req.query.limit)); }
  catch (error) { next(error); }
});

router.get("/status", requireManagement, async (req: any, res, next) => {
  try {
    res.json({ ok: true, ...(await maintenanceSummary(req.user?.location_id || req.query.location_id)) });
  } catch (error) { next(error); }
});

router.post("/run", requireManagement, async (_req, res, next) => {
  try { res.json({ ok: true, ...(await runPdfGreenAutomation()) }); }
  catch (error) { next(error); }
});

export default router;
