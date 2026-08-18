import { Router } from "express";
import legacyNotificationsRouter from "./notificationsLegacy";
import alertRuleAdminRouter from "./alertRuleAdmin";
import observabilityRouter from "./observability";
import businessReconciliationRouter from "./businessReconciliation";
import { requireManagement } from "../middleware/requireRoles";
import { startAlertRuleScheduler } from "../services/alertRuleEngine";
import { startObservabilityWorker } from "../services/observabilityApm";
import { ensureTransactionTraceForensicsSchema } from "../services/transactionTraceForensics";

const router=Router();
startAlertRuleScheduler();
startObservabilityWorker();
void ensureTransactionTraceForensicsSchema().catch(error=>console.error('[transaction-trace] startup forensic schema bootstrap failed',error));
router.use("/observability",requireManagement,observabilityRouter);
router.use("/reconciliation",requireManagement,businessReconciliationRouter);
router.use("/alert-rules",alertRuleAdminRouter);
router.use("/",legacyNotificationsRouter);
export default router;
