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
    // TODO: ha nálad nem "locations" a tábla neve, itt állítsd át!
    // Itt most csak egy egyszerű lekérdezés van, hogy minél kevesebb oszlopon bukjon el.
    const result = await pool.query(
      `
      SELECT
        id,
        name
      FROM locations
      ORDER BY name;
      `
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET /api/locations error:", err);

    // FEJLESZTÉSKOR adjunk vissza demo adatot, hogy a frontend tudjon működni
    if (process.env.NODE_ENV !== "production") {
      res.json([
        { id: "demo-1", name: "Budapest – Kleopátra Központ" },
        { id: "demo-2", name: "Gödöllő – Kleopátra Szalon" },
      ]);
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
