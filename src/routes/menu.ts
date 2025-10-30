import express from "express";
import pool from "./db";

const router = express.Router();

/**
 * 🔹 Menü + almenü lekérdezés (jogosultság nélkül)
 * parent_id → hierarchia
 * order_index → sorrend
 */
router.get("/", async (req, res) => {
  try {
    res.header("Access-Control-Allow-Origin", "*");

    const result = await pool.query(
     `SELECT id, name, icon, order_index, route, parent_id, link
       FROM menus
       ORDER BY order_index ASC`
    );

    const menus = result.rows;

    // főmenük
    const mainMenus = menus.filter((m) => m.parent_id === null);

    // almenük hozzárendelése
    const structuredMenus = mainMenus.map((menu) => ({
      ...menu,
      submenus: menus.filter((sub) => sub.parent_id === menu.id),
    }));

    res.json(structuredMenus);
  } catch (err) {
    console.error("❌ Menü betöltési hiba:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

export default router;
