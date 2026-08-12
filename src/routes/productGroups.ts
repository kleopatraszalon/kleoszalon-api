import { Router, Request, Response } from "express";
import pool from "../db";
import { requireAuth } from "../middleware/auth";
import { requireMenuPermissionByMethod } from "../middleware/menuPermission";
import { ensureProductTaxonomyReady } from "../inventory/ensureProductTaxonomy";

const router = Router();
router.use(requireAuth);
router.use(requireMenuPermissionByMethod("masterdata.product-groups"));

router.get("/", async (req: Request, res: Response) => {
  try {
    await ensureProductTaxonomyReady();
    const includeInactive = String(req.query.include_inactive || "") === "1";
    const sql = `
      SELECT id,name,code,sort_order,is_active,product_type_code,product_type_name
      FROM product_groups
      WHERE ($1::boolean) OR COALESCE(is_active,true)=true
      ORDER BY
        CASE product_type_code
          WHEN 'PROFESSIONAL_RETAIL' THEN 10
          WHEN 'PROFESSIONAL' THEN 20
          WHEN 'OPERATIONS' THEN 30
          WHEN 'HOSPITALITY' THEN 40
          WHEN 'PROMOTIONAL' THEN 50
          ELSE 90
        END,
        sort_order,name
    `;
    const { rows } = await pool.query(sql, [includeInactive]);
    res.json(rows);
  } catch (err: any) {
    console.error("GET /product-groups hiba:", err);
    res.status(500).json({ error: "Nem sikerült lekérdezni a termékcsoportokat.", detail: err?.message });
  }
});

export default router;
