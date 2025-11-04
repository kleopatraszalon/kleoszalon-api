import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();

// Típusok a lekérdezésekhez
interface Service {
  id: string;
  parent_id: string | null;
  name: string;
  description: string | null;
  base_price: number;
  base_duration_minutes: number;
  is_bookable: boolean;
  active: boolean;
}

interface OverrideRow {
  service_id: string;
  custom_price: number | null;
  custom_duration_minutes: number | null;
}

/**
 * GET /api/services/available?location_id=...&employee_id=...
 *
 * Visszaadja az adott telephelyen elérhető foglalható szolgáltatásokat.
 * Ha employee_id is jön, akkor csak azokat, amiket az adott dolgozó végez.
 * (A dolgozó-specifikus ár/idő felülírást is visszaküldjük, ha létezik.)
 */
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  const { location_id, employee_id } = req.query;

  if (!location_id) {
    return res.status(400).json({ error: "location_id kötelező" });
  }

  try {
    // 🔹 1. Alap szolgáltatások azon a telephelyen
    const baseServicesResult = await pool.query<Service>(
      `
      SELECT
        s.id,
        s.parent_id,
        s.name,
        s.description,
        s.base_price,
        s.base_duration_minutes,
        s.is_bookable,
        s.active
      FROM services s
      WHERE s.active = true
        AND s.is_bookable = true
        AND EXISTS (
          SELECT 1
          FROM service_locations sl
          WHERE sl.service_id = s.id
            AND sl.location_id = $1
        )
      ORDER BY s.name ASC
      `,
      [location_id]
    );

    let services: Service[] = baseServicesResult.rows;

    // 🔹 2. Ha dolgozó szerint szűrünk
    if (employee_id) {
      const allowedResult = await pool.query<{ service_id: string }>(
        `
        SELECT DISTINCT service_id
        FROM employee_service_overrides
        WHERE employee_id = $1
        `,
        [employee_id]
      );

      const allowedIds = allowedResult.rows.map((r) => r.service_id);
      services = services.filter((svc) => allowedIds.includes(svc.id));
    }

    // 🔹 3. Dolgozó-specifikus felülírás (ár / idő)
    if (employee_id && services.length > 0) {
      const overrideResult = await pool.query<OverrideRow>(
        `
        SELECT service_id, custom_price, custom_duration_minutes
        FROM employee_service_overrides
        WHERE employee_id = $1
          AND service_id = ANY($2::uuid[])
        `,
        [employee_id, services.map((s) => s.id)]
      );

      const overrideMap: Record<
        string,
        { price?: number; dur?: number }
      > = {};

      overrideResult.rows.forEach((row) => {
        overrideMap[row.service_id] = {
          price: row.custom_price ?? undefined,
          dur: row.custom_duration_minutes ?? undefined,
        };
      });

      services = services.map((svc) => {
        const ov = overrideMap[svc.id];
        if (!ov) return svc;
        return {
          ...svc,
          base_price: ov.price ?? svc.base_price,
          base_duration_minutes: ov.dur ?? svc.base_duration_minutes,
        };
      });
    }

    // 🔹 4. Válasz a kliensnek
    return res.json({
      location_id,
      employee_id: employee_id || null,
      services,
    });
  } catch (err) {
    console.error("❌ GET /api/services/available hiba:", err);
    return res.status(500).json({ error: "Szerver hiba" });
  }
});

export default router;
