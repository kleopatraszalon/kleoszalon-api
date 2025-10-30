import express from "express";
const router = express.Router();

// fejlesztési placeholder
router.get("/", (_req, res) => res.json([{ id: 1, name: "Teszt Booking" }]));

export default router;
