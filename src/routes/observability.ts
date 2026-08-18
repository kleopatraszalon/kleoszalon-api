import { Router } from "express";
import { collectApmSnapshot, getApmAlerts, getApmDeliveryAudit, getApmHistory } from "../services/observabilityApm";

const router = Router();

router.get("/", async (req, res, next) => {
  try {
    const windowMinutes = Number(req.query.window_minutes || 15);
    const snapshot = await collectApmSnapshot({ persist:false, notify:false, windowMinutes });
    res.json(snapshot);
  } catch (error) { next(error); }
});

router.get("/history", async (req, res, next) => {
  try { res.json(await getApmHistory(Number(req.query.hours || 24))); }
  catch (error) { next(error); }
});

router.get("/alerts", async (req, res, next) => {
  try { res.json({ items:await getApmAlerts(Number(req.query.limit || 100)) }); }
  catch (error) { next(error); }
});

router.get("/deliveries", async (req, res, next) => {
  try { res.json({ items:await getApmDeliveryAudit(Number(req.query.limit || 100)) }); }
  catch (error) { next(error); }
});

router.post("/run", async (req, res, next) => {
  try {
    const snapshot = await collectApmSnapshot({ persist:true, notify:true, windowMinutes:Number(req.body?.window_minutes || 15) });
    res.json({ ok:true, snapshot });
  } catch (error) { next(error); }
});

export default router;
