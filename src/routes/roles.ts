import express from "express";
import pool from "../db";

const router = express.Router();

// Összes szerepkör lekérése
router.get("/", async (req, res) => {
  const result = await pool.query("SELECT * FROM roles ORDER BY level DESC");
  res.json(result.rows);
});

// Új szerepkör létrehozása
router.post("/", async (req, res) => {
  const { name, description, level } = req.body;
  try {
    const result = await pool.query(
      "INSERT INTO roles (name, description, level) VALUES ($1, $2, $3) RETURNING *",
      [name, description || "", level || 1]
    );
    res.json({ success: true, role: result.rows[0] });
  } catch (err) {
    console.error("❌ Hiba a szerepkör létrehozásakor:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

// Jogosultságok lekérése egy szerepkörhöz
router.get("/:roleId/permissions", async (req, res) => {
  const { roleId } = req.params;
  const result = await pool.query(
    `SELECT rp.id, m.name AS menu, rp.can_view, rp.can_edit, rp.can_delete
     FROM role_permissions rp
     JOIN menus m ON rp.menu_id = m.id
     WHERE rp.role_id = $1
     ORDER BY m.sort_order`,
    [roleId]
  );
  res.json(result.rows);
});

// Jogosultságok mentése
router.put("/:roleId/permissions", async (req, res) => {
  const { roleId } = req.params;
  const updates = req.body; // [{ id, can_view, can_edit, can_delete }]
  try {
    for (const u of updates) {
      await pool.query(
        `UPDATE role_permissions
         SET can_view=$1, can_edit=$2, can_delete=$3
         WHERE id=$4 AND role_id=$5`,
        [u.can_view, u.can_edit, u.can_delete, u.id, roleId]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Hiba a jogosultság mentésénél:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

export default router;
