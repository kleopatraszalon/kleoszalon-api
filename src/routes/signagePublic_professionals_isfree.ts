import { Router } from "express";
import pool from "../db";

const router = Router();

router.get("/professionals", async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT *, id::text AS id
      FROM public.signage_professionals
      WHERE show = true
      ORDER BY priority DESC, is_free DESC, updated_at DESC
      LIMIT 30;
    `);
    res.json({ professionals: rows });
  } catch(e:any){ res.status(500).json({ error:String(e?.message||e) }); }
});

export default router;
