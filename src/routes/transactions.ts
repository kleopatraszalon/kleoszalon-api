import express from "express";
import inventoryRouter from "./inventory";
import aiSupportRouter from "./aiSupport";

const router = express.Router();

// Pénzügyi tranzakciók – jelenleg fejlesztési placeholder.
router.get("/", (_req, res) => res.json([{ id: 1, type: "income", amount: 10000 }]));

// Készletkezelés: nyitókészlet, bevételezés, korrekció és mozgásnapló.
// Teljes API prefix: /api/transactions/inventory
router.use("/inventory", inventoryRouter);

// Beépített AI használati asszisztens.
// Teljes API prefix: /api/transactions/ai-support/chat
router.use("/ai-support", aiSupportRouter);

export default router;
