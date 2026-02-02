// src/routes/employee_calendar.ts
import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();

/**
 * GET /api/employee-calendar/:id?from=2025-02-01&to=2025-02-07
 *
 * Visszaadja egy adott dolgozó összes eseményét (időpontját)
 * a megadott intervallumban.
 *
 * Ezt használja a frontend a heti naptárhoz.
 */
router.get("/:id", requireAuth, async (req: AuthRequest, res) => {
  // 🔹 1) ID parse
  const employeeId = parseInt(req.params.id, 10);

  if (Number.isNaN(employeeId)) {
    return res.status(400).json({ error: "Érvénytelen dolgozó ID" });
  }

  // 🔹 2) Jogosultság ellenőrzés
  // admin bárkit nézhet, nem admin csak a saját naptárát
  if (req.user!.role !== "admin" && req.user!.id !== employeeId) {
    return res.status(403).json({ error: "Nincs jogosultság ehhez a naptárhoz" });
  }

  // 🔹 3) Dátum intervallum a query-ből
  const from = (req.query.from as string) || "";
  const to = (req.query.to as string) || "";

  if (!from || !to) {
    return res.status(400).json({ error: "Hiányzó 'from' vagy 'to' query paraméter" });
  }

  try {
    // 🔹 4) Lekérdezés az adatbázisból
    const result = await pool.query(
      `
      SELECT 
        a.id,
        a.title,
        a.start_time,
        a.end_time,
        a.status,
        a.price,
        a.notes,
        a.location_id,
        l.name AS location_name,
        c.full_name AS client_name,
        s.name AS service_name
      FROM appointments a
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN clients   c ON c.id = a.client_id
      LEFT JOIN services  s ON s.id = a.service_id
      WHERE a.employee_id = $1
        AND a.start_time >= $2
        AND a.end_time   <= $3
      ORDER BY a.start_time ASC
      `,
      [employeeId, from, to]
    );

    // 🔹 5) Adatok formázása a frontendnek
    const events = result.rows.map((row: any) => ({
      id: row.id,
      title:
        row.title ||
        `${row.service_name || "Szolgáltatás"} - ${
          row.client_name || "Vendég"
        }`,
      start: row.start_time,
      end: row.end_time,
      status: row.status,
      price: row.price,
      notes: row.notes,
      location_id: row.location_id,
      location_name: row.location_name,
      client_name: row.client_name || null,
      service_name: row.service_name || null,
    }));

    // 🔹 6) Válasz
    return res.json({
      employee_id: employeeId,
      from,
      to,
      events,
    });
  } catch (err) {
    console.error("❌ GET /api/employee-calendar/:id hiba:", err);
    return res.status(500).json({ error: "Szerver hiba" });
  }
});

export default router;
