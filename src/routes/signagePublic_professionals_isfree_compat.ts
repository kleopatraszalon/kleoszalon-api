import { Router } from "express";
import { pool } from "../db";

// Public list for signage professionals.
// NOTE: Only `show=true` rows are returned, but `is_free` can be true/false.

const router = Router();

router.get("/professionals", async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `
      SELECT id, name, title, note,
             priority,
             is_free
      FROM signage_professionals
      WHERE show = true
      ORDER BY priority DESC, is_free DESC, updated_at DESC
      `
    );

    const professionals = rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      title: r.title,
      note: r.note,
      priority: Number(r.priority ?? 0),
      is_free: !!r.is_free,
      // legacy alias
      available: !!r.is_free,
    }));

    res.json({ professionals });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? "Failed to list professionals" });
  }
});

export default router;
