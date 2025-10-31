import express from "express";
import { pool } from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();

/**
 * GET /api/employees/:id/calendar?from=2025-02-01&to=2025-02-07
 *
 * Visszaadja egy adott dolgozó összes eseményét (időpontját)
 * a megadott intervallumban.
 *
 * Ez kell ahhoz, hogy a felugró modalban lásd a heti naptárát.
 */
router.get("/:id/calendar", requireAuth, async (req: AuthRequest, res) => {
  const { id } = req.params;
  const { from, to } = req.query;

  if (!from || !to) {
    return res.status(400).json({
      error: "Hiányzó dátum intervallum. Paraméterek: from=YYYY-MM-DD&to=YYYY-MM-DD",
    });
  }

  try {
    // FONTOS: itt akár azt is ellenőrizhetjük,
    // hogy a req.user.role pl. 'admin' vagy ő maga az adott employee.
    // Ha nem admin és nem önmaga -> 403
    if (req.user!.role !== "admin" && req.user!.id !== id) {
      // recepciós is láthatja? ha igen, akkor engedjük:
      if (req.user!.role !== "receptionist") {
        return res.status(403).json({ error: "Nincs jogosultság ehhez a naptárhoz" });
      }
    }

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
      [id, from, to]
    );

    // Frontend oldalon a react-big-calendar `events` prop ilyen formát vár:
    // { id, title, start: Date, end: Date, ... }
    const mapped = result.rows.map((row) => ({
      id: row.id,
      title: row.title || `${row.service_name || "Szolgáltatás"} - ${row.client_name || "Vendég"}`,
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

    return res.json({
      employee_id: id,
      from,
      to,
      events: mapped,
    });
  } catch (err) {
    console.error("GET /api/employees/:id/calendar hiba:", err);
    return res.status(500).json({ error: "Szerver hiba" });
  }
});

export default router;
