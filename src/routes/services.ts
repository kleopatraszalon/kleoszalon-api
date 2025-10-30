// src/routes/services.ts
import express from "express";
import { pool } from "../db";
import jwt from "jsonwebtoken";

const router = express.Router();

// ugyanaz az auth helper
function authenticate(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: "Nincs token" });
  }

  try {
    const token = auth.split(" ")[1];
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);

    req.user = {
      id: decoded.userId,
      role: decoded.role || "guest",
      location_id: decoded.location_id || null,
    };

    next();
  } catch (err) {
    return res.status(403).json({ error: "Érvénytelen token" });
  }
}

// GET /api/services
// Visszaadja kategóriánként
router.get("/", authenticate, async (_req: any, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        price,
        duration_minutes,
        category_name
      FROM services
      ORDER BY category_name, name;
      `
    );

    // group -> { [category_name]: [services...] }
    const bucket: Record<string, any[]> = {};

    for (const row of result.rows) {
      const cat = row.category_name || "Egyéb";
      if (!bucket[cat]) bucket[cat] = [];

      bucket[cat].push({
        id: row.id,
        name: row.name,
        price: Number(row.price) || 0,
        duration_minutes: row.duration_minutes || 0,
      });
    }

    // átalakítjuk array-re [{category, services:[...]}]
    const response = Object.entries(bucket).map(([category, services]) => ({
      category,
      services,
    }));

    res.json(response);
  } catch (err) {
    console.error("❌ Szolgáltatások lekérése hiba:", err);
    res.status(500).json({ error: "Szolgáltatások betöltése sikertelen" });
  }
});

export default router;
