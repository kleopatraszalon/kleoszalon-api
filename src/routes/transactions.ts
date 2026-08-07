import express from "express";
import inventoryRouter from "./inventory";
import aiSupportRouter from "./aiSupport";
import collaborationChatRouter from "./collaborationChat";

const router = express.Router();

// Pénzügyi tranzakciók – jelenleg fejlesztési placeholder.
router.get("/", (_req, res) => res.json([{ id: 1, type: "income", amount: 10000 }]));

// Készletkezelés: nyitókészlet, bevételezés, korrekció és mozgásnapló.
router.use("/inventory", inventoryRouter);

// Beépített AI használati asszisztens.
router.use("/ai-support", aiSupportRouter);

// Belső munkatársi chat.
router.use("/staff-chat", collaborationChatRouter);

export default router;
