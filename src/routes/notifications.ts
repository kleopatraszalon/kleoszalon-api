import { Router } from "express";
import legacyNotificationsRouter from "./notificationsLegacy";
import alertRuleAdminRouter from "./alertRuleAdmin";
import pdfComplianceRouter from "./pdfCompliance";
import { startAlertRuleScheduler } from "../services/alertRuleEngine";
import { startPdfGreenComplianceScheduler } from "../compliance/pdfGreenCompliance";

const router=Router();
startAlertRuleScheduler();
startPdfGreenComplianceScheduler();
router.use("/alert-rules",alertRuleAdminRouter);
router.use("/pdf-compliance",pdfComplianceRouter);
router.use("/",legacyNotificationsRouter);
export default router;
