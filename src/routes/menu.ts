// src/routes/menu.ts
import * as express from "express";
import pool from "../db.js";
import jwt from "jsonwebtoken";

const router = express.Router();

// --- Felhasználói szerepkör kinyerése a Bearer tokenből ---
function getUserRole(req: express.Request): string {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  const secret = process.env.JWT_SECRET;
  if (!token || !secret) return "all";
  try {
    const payload: any = jwt.verify(token, secret);
    return (payload?.role || "all").toString().toLowerCase();
  } catch {
    return "all";
  }
}

router.get("/", async (req, res) => {
  const userRole = getUserRole(req); // 'all' | 'employee' | 'admin' ...

  const baseSelect = `
    id, name, icon, route, order_index, parent_id
  `;

  const sqlWithRole = `
    SELECT ${baseSelect}, LOWER(role) AS role
    FROM menus
    WHERE LOWER(role) = 'all' OR LOWER(role) = $1
    ORDER BY COALESCE(parent_id, 0) ASC, order_index ASC, id ASC
  `;

  const sqlNoRole = `
    SELECT ${baseSelect}, 'all'::text AS role
    FROM menus
    ORDER BY COALESCE(parent_id, 0) ASC, order_index ASC, id ASC
  `;

  try {
    let rows: any[] = [];
    try {
      const r1 = await pool.query(sqlWithRole, [userRole]);
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
        name: r.name,
        icon: r.icon ?? null,
        route: r.route,
        order_index: r.order_index ?? 0,
        parent_id: r.parent_id ?? null,
        role: r.role ?? "all",
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
