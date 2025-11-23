// src/routes/locations.ts
import { Router, Request, Response } from "express";
import pool from "../db";

const router = Router();

/**
 * Telephelyek (locations) listázása.
 * Ha a router az /api alá van bekötve (app.use("/api", locationsRoutes)),
 * akkor az elérési út: GET /api/locations
 */
async function listLocations(_req: Request, res: Response): Promise<void> {
  try {
    const result = await pool.query(
      `
      SELECT
        id,
        name,
        address,
        city,
        phone,
        COALESCE(is_active, TRUE) AS active
      FROM public.locations
      WHERE COALESCE(is_active, TRUE)
      ORDER BY city, name;
      `
    );

    res.json({ items: result.rows });
  } catch (err) {
    console.error("GET /api/locations error:", err);

    // FEJLESZTÉSKOR adjunk vissza demo adatot, hogy a frontend tudjon működni
    if (process.env.NODE_ENV !== "production") {
      res.json({
        items: [
          {
            id: "demo-1",
            name: "Budapest – Kleopátra Központ",
            address: "Demo utca 1.",
            city: "Budapest",
            phone: "+361234567",
            active: true,
          },
          {
            id: "demo-2",
            name: "Gödöllő – Kleopátra Szalon",
            address: "Demo tér 2.",
            city: "Gödöllő",
            phone: "+3620123456",
            active: true,
          },
        ],
      });
      return;
    }

    // ÉLESBEN maradjon a 500-as hiba
    res.status(500).json({
      success: false,
      error: "Nem sikerült lekérni a telephelyeket.",
    });
  }
}

// Ha a router "/api" alá kerül, ez = GET /api/locations
router.get("/locations", listLocations);

export default router;
