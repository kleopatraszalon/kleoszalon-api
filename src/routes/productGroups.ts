import { Router, Request, Response } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";
import { requireMenuPermissionByMethod } from "../middleware/menuPermission";

const router = Router();
router.use(requireAuth);
router.use(requireMenuPermissionByMethod("masterdata.product-groups"));

router.get("/", async (_req: Request, res: Response) => {
  try {
    const sql = `
      SELECT id, name, code, sort_order, is_active
      FROM product_groups
      ORDER BY sort_order, name
    `;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (err) {
    console.error("GET /product-groups hiba:", err);
    res.status(500).json({ error: "Nem sikerült lekérdezni a termékcsoportokat." });
  }
});

export default router;
