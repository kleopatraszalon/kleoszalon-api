// src/routes/publicServices.ts
import { Router } from "express";
import path from "node:path";
import fs from "node:fs";
import pool from "../db"; // nálad amiből a pg Pool jön

const router = Router();

// SQL betöltése a dist/sql-ből build után
const sqlPublicServices = fs.readFileSync(
  path.join(__dirname, "..", "sql", "public_services_list.sql"),
  "utf8"
);

// GET /api/public/services
router.get("/public/services", async (req, res, next) => {
  try {
    const result = await pool.query(sqlPublicServices);
    res.json(result.rows);
  } catch (err) {
    console.error("Hiba a public services lekérdezésnél:", err);
    next(err);
  }
});

export default router;
