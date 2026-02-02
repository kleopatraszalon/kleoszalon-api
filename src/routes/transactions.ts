import express from "express";
const router = express.Router();

// fejlesztési placeholder
router.get("/", (_req, res) => res.json([{ id: 1, type: "income", amount: 10000 }]));

export default router;
