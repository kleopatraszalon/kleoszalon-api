import { Router } from "express";
import db from "../db";
import { requireAuth } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

router.get("/setup-options", async (_req, res) => {
  try {
    const [locations, services, employees] = await Promise.all([
      db.query(`SELECT id::text,name FROM locations ORDER BY name`),
      db.query(`SELECT id::text,name FROM services WHERE COALESCE(is_active,true)=true ORDER BY name`),
      db.query(`SELECT id::text,COALESCE(full_name,name,'') name,location_id::text
        FROM employees WHERE COALESCE(active,true)=true ORDER BY COALESCE(full_name,name,'')`),
    ]);
    res.json({ locations: locations.rows, services: services.rows, employees: employees.rows });
  } catch (error: any) {
    res.status(500).json({ error: "A várólista választási adatai nem tölthetők be.", detail: error?.message || String(error) });
  }
});

export default router;
