import express, { Request, Response, NextFunction } from "express";
import { pool } from "../db";
import jwt from "jsonwebtoken";

const router = express.Router();

/* ───────────────── TÍPUSOK ───────────────── */

interface AuthUser {
  id: string;
  role: string;
  location_id?: string | null;
}

interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

/* 🔐 Autentikáció middleware
   - kiveszi a Bearer tokent
   - jwt.verify
   - ráteszi a req.user-t (id, role, location_id)
*/
function authenticate(req: Request, res: Response, next: NextFunction) {
  const auth = req.headers.authorization;
  if (!auth) {
    return res.status(401).json({ error: "Nincs token" });
  }

  try {
    const token = auth.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as any;
(req as AuthenticatedRequest).user = {
  id: decoded.userId,
  role: decoded.role,           // <-- ez a DB-ben beállított szerep!
  location_id: decoded.location_id || null,
} as any;

    // tokenben legyen: userId, role, location_id
    (req as AuthenticatedRequest).user = {
      id: decoded.userId,
      role: decoded.role || "guest",
      location_id: decoded.location_id || null,
    };

    next();
  } catch (err) {
    console.error("Auth hiba:", err);
    return res.status(403).json({ error: "Érvénytelen token" });
  }
}

/* 🛂 Jogosultság ellenőrzés middleware
   - pl. allowRoles("receptionist","employee","admin")
   - admin mindig átmehet
*/
function allowRoles(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;

    if (!authReq.user || !authReq.user.role) {
      return res.status(403).json({ error: "Nincs jogosultság" });
    }

    if (roles.includes(authReq.user.role) || authReq.user.role === "admin") {
      return next();
    }

    return res
      .status(403)
      .json({ error: "Nincs jogosultság ehhez a művelethez" });
  };
}

/* 📋 1) Munkalapok listázása
   - visszaadjuk a munkalap alapadatait
   - hozzácsatolva dolgozó / vendég nevet
   - telephely szűrés: csak a saját telephely (location_id),
     kivéve admin (ő mindent)
*/
router.get(
  "/",
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const authReq = req as AuthenticatedRequest;
      const isAdmin = authReq.user.role === "admin";

      const params: any[] = [];
      let whereClause = "";

      if (!isAdmin && authReq.user.location_id) {
        // csak a saját telephely
        params.push(authReq.user.location_id);
        whereClause = "WHERE w.location_id = $1";
      }

      const result = await pool.query(
        `
        SELECT 
          w.id,
          w.created_at,
          w.visit_status,
          w.record_note,
          w.total_price,
          w.location_id,

          -- ügyfél pillanatkép adatok a munkalapon
          w.client_first_name,
          w.client_last_name,
          w.client_phone,
          w.client_email,

          -- dolgozó
          e.name AS employee_name

        FROM work_orders w
        LEFT JOIN employees e ON w.employee_id = e.id
        ${whereClause}
        ORDER BY w.created_at DESC
        `,
        params
      );

      res.json(result.rows);
    } catch (err) {
      console.error("❌ Munkalap lekérdezési hiba:", err);
      res.status(500).json({ error: "Adatbázis hiba" });
    }
  }
);

/* 📄 2) Egy konkrét munkalap lekérdezése részletesen
   - fejléc (státusz, megjegyzés, dolgozó)
   - szolgáltatások listája (work_order_services)
*/
router.get(
  "/:id",
  authenticate,
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const authReq = req as AuthenticatedRequest;

    try {
      // fej
      const workOrderRes = await pool.query(
        `
        SELECT 
          w.*,
          e.name AS employee_name
        FROM work_orders w
        LEFT JOIN employees e ON w.employee_id = e.id
        WHERE w.id = $1
        `,
        [id]
      );

      if (workOrderRes.rows.length === 0) {
        res.status(404).json({ error: "Munkalap nem található" });
        return;
      }

      const workOrder = workOrderRes.rows[0];

      // jogosultság: ha nem admin, csak a saját telephely
      if (
        authReq.user.role !== "admin" &&
        authReq.user.location_id &&
        workOrder.location_id !== authReq.user.location_id
      ) {
        res
          .status(403)
          .json({ error: "Más telephely munkalapját nem érheted el" });
        return;
      }

      // tételek
      const servicesRes = await pool.query(
        `
        SELECT
          ws.id,
          ws.service_id,
          s.name AS service_name,
          ws.price,
          ws.duration_minutes
        FROM work_order_services ws
        LEFT JOIN services s ON s.id = ws.service_id
        WHERE ws.work_order_id = $1
        `,
        [id]
      );

      res.json({
        work_order: workOrder,
        services: servicesRes.rows,
      });
    } catch (err) {
      console.error("❌ Munkalap részletek lekérdezési hiba:", err);
      res.status(500).json({ error: "Adatbázis hiba" });
    }
  }
);

/* ➕ 3) Új munkalap létrehozása
   - ez felel meg a WorkOrderNew.tsx mentés gombjának
   - body (frontend felől):
     {
       employee_id,
       visit_status,
       record_note,
       client_first_name,
       client_last_name,
       client_phone,
       client_email,
       services: [
         { service_id, price, duration_minutes }
       ]
     }
*/
router.post(
  "/",
  authenticate,
  allowRoles("receptionist", "employee", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const authReq = req as AuthenticatedRequest;

    const {
      employee_id,
      visit_status,
      record_note,
      client_first_name,
      client_last_name,
      client_phone,
      client_email,
      services,
    } = req.body;

    // alap validáció
    if (!employee_id) {
      res
        .status(400)
        .json({ error: "Hiányzik a dolgozó (employee_id)" });
      return;
    }
    if (!services || !Array.isArray(services) || services.length === 0) {
      res
        .status(400)
        .json({ error: "Nincs kiválasztott szolgáltatás" });
      return;
    }

    // total_price = a kiválasztott szolgáltatások összege
    const total_price = services.reduce(
      (sum: number, s: any) => sum + (Number(s.price) || 0),
      0
    );

    // location_id: a felhasználó telephelye (admin is kapja ezt most)
    const location_id = authReq.user.location_id || null;

    try {
      await pool.query("BEGIN");

      // 1. beszúrjuk a munkalapot
      const insertWO = await pool.query(
        `
        INSERT INTO work_orders
        (
          employee_id,
          visit_status,
          record_note,
          client_first_name,
          client_last_name,
          client_phone,
          client_email,
          total_price,
          location_id
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
        `,
        [
          employee_id,
          visit_status || "várakozik",
          record_note || "",
          client_first_name || "",
          client_last_name || "",
          client_phone || "",
          client_email || "",
          total_price,
          location_id,
        ]
      );

      const newWorkOrder = insertWO.rows[0];
      const workOrderId = newWorkOrder.id;

      // 2. beszúrjuk a szolgáltatás tételeket
      for (const s of services) {
        await pool.query(
          `
          INSERT INTO work_order_services
          (work_order_id, service_id, price, duration_minutes)
          VALUES ($1,$2,$3,$4)
          `,
          [
            workOrderId,
            s.service_id,
            s.price || 0,
            s.duration_minutes || 0,
          ]
        );
      }

      await pool.query("COMMIT");

      res.status(201).json({
        success: true,
        work_order: newWorkOrder,
      });
    } catch (err) {
      await pool.query("ROLLBACK");
      console.error("❌ Munkalap mentési hiba:", err);
      res.status(500).json({ error: "Mentés sikertelen" });
    }
  }
);

/* ✏️ 4) Munkalap módosítása (státusz, megjegyzés stb.)
   - csak admin / receptionist / employee
   - telephely ellenőrzés
*/
router.put(
  "/:id",
  authenticate,
  allowRoles("receptionist", "employee", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const { visit_status, record_note } = req.body;
    const authReq = req as AuthenticatedRequest;

    try {
      // először lekérjük, hogy a user módosíthatja-e
      const checkRes = await pool.query(
        "SELECT location_id FROM work_orders WHERE id = $1",
        [id]
      );
      if (checkRes.rows.length === 0) {
        res.status(404).json({ error: "Munkalap nem található" });
        return;
      }

      const row = checkRes.rows[0];
      if (
        authReq.user.role !== "admin" &&
        authReq.user.location_id &&
        row.location_id !== authReq.user.location_id
      ) {
        res.status(403).json({
          error: "Más telephely munkalapját nem módosíthatod",
        });
        return;
      }

      // frissítjük
      const result = await pool.query(
        `
        UPDATE work_orders
        SET visit_status = COALESCE($1, visit_status),
            record_note  = COALESCE($2, record_note)
        WHERE id = $3
        RETURNING *
        `,
        [visit_status || null, record_note || null, id]
      );

      res.json({
        success: true,
        work_order: result.rows[0],
      });
    } catch (err) {
      console.error("❌ Munkalap módosítási hiba:", err);
      res.status(500).json({ error: "Frissítés sikertelen" });
    }
  }
);

/* ❌ 5) Munkalap törlése
   - csak admin és receptionist törölhessen (a sima employee ne törölje teljesen)
   - telephely ellenőrzés
*/
router.delete(
  "/:id",
  authenticate,
  allowRoles("receptionist", "admin"),
  async (req: Request, res: Response): Promise<void> => {
    const { id } = req.params;
    const authReq = req as AuthenticatedRequest;

    try {
      // ellenőrizzük location jogot
      const checkRes = await pool.query(
        "SELECT location_id FROM work_orders WHERE id = $1",
        [id]
      );
      if (checkRes.rows.length === 0) {
        res.status(404).json({ error: "Munkalap nem található" });
        return;
      }

      const row = checkRes.rows[0];
      if (
        authReq.user.role !== "admin" &&
        authReq.user.location_id &&
        row.location_id !== authReq.user.location_id
      ) {
        res.status(403).json({
          error: "Más telephely munkalapját nem törölheted",
        });
        return;
      }

      // töröljük a munkalapot és a sorait
      await pool.query("BEGIN");
      await pool.query(
        "DELETE FROM work_order_services WHERE work_order_id = $1",
        [id]
      );
      await pool.query("DELETE FROM work_orders WHERE id = $1", [id]);
      await pool.query("COMMIT");

      res.json({ success: true });
    } catch (err) {
      await pool.query("ROLLBACK");
      console.error("❌ Munkalap törlés hiba:", err);
      res.status(500).json({ error: "Törlés sikertelen" });
    }
  }
);

export default router;
