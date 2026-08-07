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

const router = express.Router();
router.get("/", (_req, res) => res.json([{ id: 1, type: "income", amount: 10000 }]));

// Az adatbázis-sémát pgAdmin migrációk kezelik. Runtime közben nem futtatunk
// CREATE/ALTER TABLE műveleteket, mert a Render adatbázis-felhasználó jogosultsága
// és a már meglévő oszloptípusok miatt ez az összes beszerzési GET kérést 500-zal
// blokkolhatta. A route-ok csak üzleti adatot olvasnak/írnak.
router.use("/inventory", inventoryRouter);
router.use("/procurement", purchaseOrdersRouter);
router.use("/procurement-workflow", procurementWorkflowRouter);
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
