import { Router } from "express";
import legacyNotificationsRouter from "./notificationsLegacy";
import alertRuleAdminRouter from "./alertRuleAdmin";
import observabilityRouter from "./observability";
import businessReconciliationRouter from "./businessReconciliation";
import { requireManagement } from "../middleware/requireRoles";
import { startAlertRuleScheduler } from "../services/alertRuleEngine";
import { startObservabilityWorker } from "../services/observabilityApm";

const router=Router();
startAlertRuleScheduler();
startObservabilityWorker();
router.use("/observability",requireManagement,observabilityRouter);
router.use("/reconciliation",requireManagement,businessReconciliationRouter);
router.use("/alert-rules",alertRuleAdminRouter);
router.use("/",legacyNotificationsRouter);
export default router;
