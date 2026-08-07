import express from "express";
import inventoryRouter from "./inventory";
import aiSupportRouter from "./aiSupport";
import collaborationChatRouter from "./collaborationChat";
import cashierRouter from "./cashier";
import notificationsRouter from "./notifications";
import managementSummaryRouter from "./managementSummary";
import dashboardSettingsRouter from "./dashboardSettings";

const router = express.Router();

router.get("/", (_req, res) => res.json([{ id: 1, type: "income", amount: 10000 }]));
router.use("/inventory", inventoryRouter);
router.use("/ai-support", aiSupportRouter);
router.use("/staff-chat", collaborationChatRouter);
router.use("/cashier", cashierRouter);
router.use("/cashier/management-summary", managementSummaryRouter);
router.use("/notifications", notificationsRouter);
router.use("/management", managementSummaryRouter);
router.use("/dashboard-settings", dashboardSettingsRouter);

export default router;
