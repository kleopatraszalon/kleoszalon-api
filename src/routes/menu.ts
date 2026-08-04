// src/routes/menu.ts
import * as express from "express";
import pool from "../db";

const router = express.Router();

router.get("/", async (_req, res) => {
  const baseSelect = `
    id, code, name, icon, route, order_index, parent_id, feature_key
  `;

  const sqlCurrent = `
    SELECT ${baseSelect}, 'all'::text AS role
    FROM menus
    WHERE COALESCE(is_active, true) = true
    ORDER BY COALESCE(parent_id, 0) ASC, order_index ASC, id ASC
  `;

  const sqlNoRole = `
    SELECT id, NULL::text AS code, name, icon, route, order_index, parent_id,
           NULL::text AS feature_key, 'all'::text AS role
    FROM menus
    ORDER BY COALESCE(parent_id, 0) ASC, order_index ASC, id ASC
  `;

  try {
    let rows: any[] = [];
    try {
      const r1 = await pool.query(sqlCurrent);
      rows = r1.rows;
    } catch (err: any) {
      if (err?.code === "42703") {
        const r2 = await pool.query(sqlNoRole);
        rows = r2.rows;
      } else {
        throw err;
      }
    }

    // --- Hierarchia építés ---
    const byId = new Map<number, any>();
    rows.forEach((r) => {
      byId.set(r.id, {
        id: r.id,
        code: r.code ?? null,
        name: r.name,
        icon: r.icon ?? null,
        route: r.route,
        order_index: r.order_index ?? 0,
        parent_id: r.parent_id ?? null,
        role: r.role ?? "all",
        required_role: r.role ?? "all",
        feature_key: r.feature_key ?? null,
        submenus: [] as any[],
      });
    });

    const roots: any[] = [];
    rows.forEach((r) => {
      const item = byId.get(r.id);
      if (r.parent_id && byId.has(r.parent_id)) {
        byId.get(r.parent_id).submenus.push(item);
      } else {
        roots.push(item);
      }
    });

    const sortTree = (arr: any[]) => {
      arr.sort(
        (a, b) =>
          (a.order_index ?? 0) - (b.order_index ?? 0) || a.id - b.id
      );
      arr.forEach((n) => sortTree(n.submenus));
    };
    sortTree(roots);

    return res.status(200).json(roots);
  } catch (err: any) {
    console.error("❌ Menü betöltési hiba:", err?.message || err);
    return res.status(500).json({ error: "Adatbázis hiba a menü lekérésekor" });
  }
});

export default router;
