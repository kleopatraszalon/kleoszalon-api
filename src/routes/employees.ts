// backend/src/routes/employees.ts
import express from "express";
import { pool } from "../db";
import jwt from "jsonwebtoken";

const router = express.Router();

/* ---------- AUTH MIDDLEWARE ---------- */
/*
   Elvárás:
   - Authorization: Bearer <token>
   - A tokenben benne legyen pl. { user_id: "...", role: "admin" }
*/
function authenticate(req: any, res: any, next: any) {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: "Nincs token" });
  }

  try {
    const token = auth.split(" ")[1];
    const decoded: any = jwt.verify(token, process.env.JWT_SECRET as string);
    req.user = decoded;
    next();
  } catch (err) {
    console.error("JWT hiba:", err);
    return res.status(403).json({ error: "Érvénytelen token" });
  }
}

/* ---------- ROLE CHECK MIDDLEWARE ---------- */
/*
   Csak bizonyos szerepkör láthatja a dolgozók listáját.
   - admin, receptionist, employee (szakember)
   A vendég NE lássa a teljes listát.
*/
function authorizeEmployeeList(req: any, res: any, next: any) {
  const role = req.user?.role;
  if (!role) {
    return res.status(403).json({ error: "Nincs jogosultság (nincs szerepkör)" });
  }

  // ide beírjuk kik láthatják a listát
  const allowed = ["admin", "receptionist", "employee"];
  if (!allowed.includes(role)) {
    return res.status(403).json({ error: "Nincs jogosultság ehhez az erőforráshoz" });
  }

  next();
}

/*
  Egyetlen dolgozó részletes adatait
  - admin és receptionist bárkiről lát mindent
  - employee (szakember) csak a saját adatát láthatja, ne a többiekét
*/
function authorizeEmployeeDetails(req: any, res: any, next: any) {
  const role = req.user?.role;
  const currentUserId = req.user?.user_id; // ez legyen benne a tokenben
  const requestedId = req.params.id;

  if (!role) {
    return res.status(403).json({ error: "Nincs jogosultság (nincs szerepkör)" });
  }

  if (role === "admin" || role === "receptionist") {
    return next();
  }

  if (role === "employee") {
    // szakember csak a SAJÁT rekordját nézheti
    if (currentUserId === requestedId) {
      return next();
    } else {
      return res.status(403).json({ error: "Nem férhetsz hozzá más dolgozó adatlapjához" });
    }
  }

  // más szerepkör nem férhet hozzá
  return res.status(403).json({ error: "Nincs jogosultság ehhez az erőforráshoz" });
}

/* ===========================================================
   GET /api/employees
   Dolgozók LISTÁJA a táblád szerint
   - életkorhoz: birth_date
   - telephelyhez: locations.name AS location_name
   - erre épít a frontend EmployeesList.tsx
=========================================================== */
router.get("/", authenticate, authorizeEmployeeList, async (req, res) => {
  try {
    /*
      employees tábla oszlopok, amiket most ténylegesen akarunk listázni:
      - id (uuid)
      - full_name / first_name / last_name
      - birth_date
      - qualification
      - monthly_wage / hourly_wage
      - photo_url
      - location_id
      - locations.name AS location_name

      Ez a JOIN fontos, hogy a telephely nevét is visszaadjuk.
    */
    const result = await pool.query(
      `
      SELECT
        e.id,
        e.full_name,
        e.first_name,
        e.last_name,
        e.birth_date,
        e.qualification,
        e.monthly_wage,
        e.hourly_wage,
        e.photo_url,
        e.location_id,
        l.name AS location_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.active = true
      ORDER BY e.last_name, e.first_name;
      `
    );

    return res.json(result.rows);
  } catch (err) {
    console.error("❌ /api/employees hiba:", err);
    return res.status(500).json({ error: "Adatbázis hiba a dolgozók listázásánál" });
  }
});

/* ===========================================================
   GET /api/employees/:id
   EGY dolgozó részletes adatai
   - itt visszaadunk MINDENT amit a táblád tartalmaz,
     mert az EmployeeDetails.tsx teljes HR profilt akar mutatni
=========================================================== */
router.get("/:id", authenticate, authorizeEmployeeDetails, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `
      SELECT
        e.id,
        e.location_id,
        l.name AS location_name,

        e.full_name,
        e.first_name,
        e.last_name,
        e.active,
        e.role,

        e.birth_name,
        e.birth_date,
        e.birth_country,
        e.birth_region,
        e.birth_city,
        e.nationality,
        e.gender,
        e.mother_name,

        e.taj_number,
        e.tax_id,

        e.qualification,
        e.work_schedule_type,
        e.work_schedule_type_id,
        e.employment_type,
        e.employment_type_id,

        e.hourly_rate,
        e.hourly_wage,
        e.monthly_wage,

        e.photo_url,
        e.bio,
        e.color,

        e.department_id,
        e.position_id,

        e.notes,
        e.review_notes,
        e.traits,

        e.created_at
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = $1
      LIMIT 1;
      `,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Dolgozó nem található" });
    }

    return res.json(result.rows[0]);
  } catch (err) {
    console.error("❌ /api/employees/:id hiba:", err);
    return res.status(500).json({ error: "Adatbázis hiba a dolgozó lekérésénél" });
  }
});

export default router;
