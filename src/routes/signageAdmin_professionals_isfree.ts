import { Router } from "express";
import pool from "../db";

const router = Router();

// Professionals CRUD with is_free
router.get("/professionals", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT *, id::text AS id_text FROM public.signage_professionals ORDER BY show DESC, priority DESC, updated_at DESC`);
    res.json({ professionals: rows.map((r:any)=>({ ...r, id: r.id_text })) });
  } catch(e:any){ res.status(500).json({ error:String(e?.message||e) }); }
});

router.post("/professionals", async (req, res) => {
  try {
    const { name, title, note, photo_url, show, is_free, priority } = req.body || {};
    if(!name) return res.status(400).json({ error:"name required" });
    const { rows } = await pool.query(
      `INSERT INTO public.signage_professionals (name, title, note, photo_url, show, is_free, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *, id::text AS id`,
      [name, title ?? "", note ?? "", photo_url ?? "", show ?? true, is_free ?? true, priority ?? 0]
    );
    res.json({ professional: rows[0] });
  } catch(e:any){ res.status(500).json({ error:String(e?.message||e) }); }
});

router.put("/professionals/:id", async (req, res) => {
  try {
    const id = String(req.params.id);
    const fields = ["name","title","note","photo_url","show","is_free","priority"];
    const sets:string[]=[]; const vals:any[]=[]; let i=1;
    for (const f of fields) if (req.body && Object.prototype.hasOwnProperty.call(req.body, f)) { sets.push(`${f}=$${i++}`); vals.push(req.body[f]); }
    if(!sets.length) return res.json({ ok:true });
    vals.push(id);
    const { rows } = await pool.query(`UPDATE public.signage_professionals SET ${sets.join(", ")}, updated_at=now() WHERE id::text=$${i} RETURNING *, id::text AS id`, vals);
    if(!rows[0]) return res.status(404).json({ error:"not found" });
    res.json({ professional: rows[0] });
  } catch(e:any){ res.status(500).json({ error:String(e?.message||e) }); }
});

router.delete("/professionals/:id", async (req, res) => {
  try {
    const { rowCount } = await pool.query(`DELETE FROM public.signage_professionals WHERE id::text=$1`, [String(req.params.id)]);
    res.json({ ok: (rowCount ?? 0) > 0 });
  } catch(e:any){ res.status(500).json({ error:String(e?.message||e) }); }
});

export default router;
