// src/routes/services.ts
import { Router, Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from "jsonwebtoken";
import pool from "../db"; // ← NINCS .js kiterjesztés!

const router = Router();

/** Kiterjesztett Request user infóval */
interface AuthUser {
  id: number | string;
  role: string;
  location_id: number | string | null;
}
interface AuthRequest extends Request {
  user?: AuthUser;
}

/** Egyszerű Bearer JWT ellenőrzés */
function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Nincs token" });

  try {
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as JwtPayload & {
      userId?: number | string;
      role?: string;
      location_id?: number | string | null;
    };

    req.user = {
      id: decoded.userId as any,
      role: decoded.role ?? "guest",
      location_id: (decoded.location_id ?? null) as any,
    };
    next();
  } catch {
    return res.status(403).json({ error: "Érvénytelen token" });
  }
}

/**
 * GET /api/services
 * Szolgáltatások visszaadása kategóriákra csoportosítva.
 * A lekérdezés szándékosan általános: SELECT * FROM services,
 * hogy akkor is működjön, ha a mezőnevek kicsit eltérnek
 * (pl. duration_minutes vs. duration_min, category_name vs. category).
 */
router.get("/", authenticate, async (_req: AuthRequest, res: Response) => {
  try {
    const result = await pool.query(`SELECT * FROM services ORDER BY name;`);

    // bucket: { [category: string]: Array<service> }
    const bucket: Record<string, any[]> = {};

    for (const row of result.rows as any[]) {
      // Kategória név rugalmasan
      const category =
        row.category_name ??
        row.category ??
        row.group_name ??
        "Egyéb";

      // Időtartam rugalmasan
      const duration =
        row.duration_minutes ??
        row.duration_min ??
        row.duration ??
        0;

      // Ár stringből számmá (pg numeric általában string)
      const priceRaw = row.price ?? row.list_price ?? row.cost ?? 0;
      const price =
        typeof priceRaw === "number" ? priceRaw : parseFloat(String(priceRaw)) || 0;

      if (!bucket[category]) bucket[category] = [];
      bucket[category].push({
        id: row.id,
        name: row.name,
        price,
        duration_minutes: Number(duration) || 0,
      });
    }

    // Átalakítás tömbbé
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
