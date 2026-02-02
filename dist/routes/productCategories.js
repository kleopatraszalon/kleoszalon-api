"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const db_1 = __importDefault(require("../db"));
const router = (0, express_1.Router)();
router.get("/", async (_req, res) => {
    try {
        const sql = `
      SELECT
        c.*,
        g.name AS group_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id = c.product_group_id
      ORDER BY c.sort_order, c.name
    `;
        const { rows } = await db_1.default.query(sql);
        res.json(rows);
    }
    catch (err) {
        console.error("GET /product-categories hiba:", err);
        res.status(500).json({ error: "Nem sikerült lekérdezni a kategóriákat." });
    }
});
router.post("/", async (req, res) => {
    try {
        const b = req.body || {};
        if (!b.name || String(b.name).trim().length === 0) {
            return res.status(400).json({ error: "A kategória neve kötelező." });
        }
        if (!b.product_group_id) {
            return res.status(400).json({ error: "A termékcsoport kötelező." });
        }
        const sql = `
      INSERT INTO product_categories (
        product_group_id,
        name,
        code,
        sort_order,
        is_active
      )
      VALUES ($1,$2,$3,$4,COALESCE($5,true))
      RETURNING *
    `;
        const params = [
            b.product_group_id,
            String(b.name).trim(),
            b.code ?? null,
            b.sort_order ?? 100,
            b.is_active,
        ];
        const { rows } = await db_1.default.query(sql, params);
        const saved = rows[0];
        const { rows: rows2 } = await db_1.default.query(`
      SELECT
        c.*,
        g.name AS group_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id = c.product_group_id
      WHERE c.id = $1
      `, [saved.id]);
        res.status(201).json(rows2[0]);
    }
    catch (err) {
        console.error("POST /product-categories hiba:", err);
        res.status(500).json({ error: "Nem sikerült létrehozni a kategóriát." });
    }
});
router.patch("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const b = req.body || {};
        const fields = [];
        const values = [];
        let i = 1;
        const add = (col, val) => {
            fields.push(`${col} = $${i}`);
            values.push(val);
            i++;
        };
        if (b.name !== undefined)
            add("name", b.name);
        if (b.code !== undefined)
            add("code", b.code);
        if (b.sort_order !== undefined)
            add("sort_order", b.sort_order);
        if (b.is_active !== undefined)
            add("is_active", b.is_active);
        if (b.product_group_id !== undefined)
            add("product_group_id", b.product_group_id || null);
        if (fields.length === 0) {
            return res.json({ message: "Nincs módosítandó mező." });
        }
        values.push(id);
        const sql = `
      UPDATE product_categories
      SET ${fields.join(", ")}
      WHERE id = $${i}
      RETURNING *
    `;
        const { rows } = await db_1.default.query(sql, values);
        if (rows.length === 0) {
            return res.status(404).json({ error: "Kategória nem található." });
        }
        const saved = rows[0];
        const { rows: rows2 } = await db_1.default.query(`
      SELECT
        c.*,
        g.name AS group_name
      FROM product_categories c
      LEFT JOIN product_groups g ON g.id = c.product_group_id
      WHERE c.id = $1
      `, [saved.id]);
        res.json(rows2[0]);
    }
    catch (err) {
        console.error("PATCH /product-categories/:id hiba:", err);
        res.status(500).json({ error: "Nem sikerült módosítani a kategóriát." });
    }
});
exports.default = router;
