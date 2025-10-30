import express from "express";
import pool from "../db";
import jwt from "jsonwebtoken";

const router = express.Router();

/**
 * 🔹 Menü lekérdezése a bejelentkezett felhasználó szerepköre alapján
 * - csak az adott szerepkörhöz tartozó menüpontokat adja vissza
 * - főmenü + almenü hierarchikusan
 */
router.get("/", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: "Hiányzó jogosultság (nincs token)" });
    }

    const token = authHeader.split(" ")[1];
    let decoded: any;

    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET as string);
    } catch (err) {
      return res.status(403).json({ error: "Érvénytelen vagy lejárt token" });
    }

    const userRole = decoded.role || "guest";

    // 🔸 Menüelemek lekérdezése a szerepkör alapján
    const query = `
      SELECT id, name, icon, order_index, route, required_role, parent_id
      FROM menus
      WHERE required_role = 'all'
         OR required_role = $1
         OR $1 = 'admin'
      ORDER BY order_index ASC
    `;

    const result = await pool.query(query, [userRole]);
    const menus = result.rows || [];

    if (menus.length === 0) {
      return res.status(200).json({
        role: userRole,
        menus: [],
        message: "Nincs elérhető menüpont ehhez a szerepkörhöz.",
      });
    }

    // 🔸 Hierarchia felépítése
    const mainMenus = menus.filter((m) => m.parent_id === null);
    const structuredMenus = mainMenus.map((menu) => ({
      ...menu,
      submenus: menus.filter((sub) => sub.parent_id === menu.id),
    }));

    // ✅ Visszaadjuk a szerepkört és a menüstruktúrát
    res.json({
      success: true,
      role: userRole,
      menus: structuredMenus,
    });
  } catch (err) {
    console.error("❌ Menü lekérdezési hiba:", err);
    res.status(500).json({ error: "Adatbázis hiba vagy szerverhiba" });
  }
});

export default router;


