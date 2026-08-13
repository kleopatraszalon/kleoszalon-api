import { Router } from "express";
import legacyNotificationsRouter from "./notificationsLegacy";
import alertRuleAdminRouter from "./alertRuleAdmin";
import { startAlertRuleScheduler } from "../services/alertRuleEngine";

const router=Router();
startAlertRuleScheduler();
router.use("/alert-rules",alertRuleAdminRouter);
router.use("/",legacyNotificationsRouter);
export default router;
