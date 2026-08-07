import express from "express";
import inventoryRouter from "./inventory";
import aiSupportRouter from "./aiSupport";
import collaborationChatRouter from "./collaborationChat";
import cashierRouter from "./cashier";
import notificationsRouter from "./notifications";
import managementSummaryRouter from "./managementSummary";
import dashboardSettingsRouter from "./dashboardSettings";
import auditLogRouter from "./auditLog";
import purchaseOrdersRouter from "./purchaseOrders";
import suppliersRouter from "./suppliers";
import procurementWorkflowRouter from "./procurementWorkflow";
import { requirePurchaseOrderAccess, requireProcurementWorkflowAccess } from "../middleware/procurementAccess";

const router = express.Router();
router.get("/", (_req, res) => res.json([{ id: 1, type: "income", amount: 10000 }]));

// Az adatbázis-sémát pgAdmin migrációk kezelik. Runtime közben nem futtatunk
// CREATE/ALTER TABLE műveleteket. A beszerzési route-oknál a feature-szintű
// ellenőrzés mellett a konkrét művelet (view/create/edit/approve/export) is
// szerveroldalon érvényesül.
router.use("/inventory", inventoryRouter);
router.use("/procurement", requirePurchaseOrderAccess, purchaseOrdersRouter);
router.use("/procurement-workflow", requireProcurementWorkflowAccess, procurementWorkflowRouter);
router.use("/suppliers", suppliersRouter);
router.use("/ai-support", aiSupportRouter);
router.use("/staff-chat", collaborationChatRouter);
router.use("/cashier", cashierRouter);
router.use("/cashier/management-summary", managementSummaryRouter);
router.use("/notifications", notificationsRouter);
router.use("/management", managementSummaryRouter);
router.use("/dashboard-settings", dashboardSettingsRouter);
router.use("/audit", auditLogRouter);
export default router;
