"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const multer_1 = __importDefault(require("multer"));
const db_1 = __importDefault(require("../db"));
const crypto_1 = require("crypto");
const router = (0, express_1.Router)();
// =======================================================
//  TAXONÓMIA (TERMÉKCSOPORT + KATEGÓRIA) SEGÉDEK
//  Cél: product_group_id és product_category_id mindig legyen.
// =======================================================
const _colCache = new Map();
async function hasColumn(client, table, column) {
    const key = `${table}.${column}`;
    const cached = _colCache.get(key);
    if (cached !== undefined)
        return cached;
    const r = await client.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = $1
      AND column_name = $2
    LIMIT 1
  `, [table, column]);
    const ok = (r.rowCount ?? 0) > 0;
    _colCache.set(key, ok);
    return ok;
}
async function ensureTaxonomyTables(client) {
    // product_groups
    await client.query(`
    CREATE TABLE IF NOT EXISTS product_groups (
      id uuid PRIMARY KEY,
      name_hu text NOT NULL,
      name_en text,
      name_ru text,
      created_at timestamptz DEFAULT now()
    )
  `);
    // product_categories
    await client.query(`
    CREATE TABLE IF NOT EXISTS product_categories (
      id uuid PRIMARY KEY,
      product_group_id uuid NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE,
      name_hu text NOT NULL,
      name_en text,
      name_ru text,
      created_at timestamptz DEFAULT now()
    )
  `);
    // products bővítések (ha szükséges)
    // product_category_id
    await client.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS product_category_id uuid REFERENCES product_categories(id)
  `);
    // többnyelvű mezők (ha szeretnéd, a front ezeket tölti)
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS name_hu text`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS name_en text`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS name_ru text`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS web_description_hu text`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS web_description_en text`);
    await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS web_description_ru text`);
}
async function upsertDefaultGroup(client) {
    // Első csoport, ha van
    const existing = await client.query(`SELECT id FROM product_groups ORDER BY created_at ASC NULLS LAST, id ASC LIMIT 1`);
    if (existing.rowCount)
        return { id: existing.rows[0].id };
    const id = (0, crypto_1.randomUUID)();
    await client.query(`INSERT INTO product_groups (id, name_hu, name_en, name_ru) VALUES ($1,$2,$3,$4)`, [id, "Egyéb", "Other", "Другое"]);
    return { id };
}
async function ensureGroupId(client, maybeGroupId) {
    const g = maybeGroupId ? String(maybeGroupId).trim() : "";
    if (g) {
        const ok = await client.query(`SELECT 1 FROM product_groups WHERE id=$1`, [g]);
        if (ok.rowCount)
            return g;
        // ha UUID-t kaptunk, de nincs ilyen, létrehozzuk "Névtelen" csoportként
        await client.query(`INSERT INTO product_groups (id, name_hu, name_en, name_ru) VALUES ($1,$2,$3,$4)
       ON CONFLICT (id) DO NOTHING`, [g, "Új csoport", "New group", "Новая группа"]);
        return g;
    }
    return (await upsertDefaultGroup(client)).id;
}
async function ensureCategoryId(client, groupId, maybeCategoryId) {
    const c = maybeCategoryId ? String(maybeCategoryId).trim() : "";
    if (c) {
        const ok = await client.query(`SELECT 1 FROM product_categories WHERE id=$1`, [c]);
        if (ok.rowCount)
            return c;
        // ha UUID-t kaptunk, de nincs ilyen: létrehozzuk a csoport alá
        await client.query(`INSERT INTO product_categories (id, product_group_id, name_hu, name_en, name_ru)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`, [c, groupId, "Új kategória", "New category", "Новая категория"]);
        return c;
    }
    // első kategória a csoport alatt, ha van
    const existing = await client.query(`SELECT id FROM product_categories WHERE product_group_id=$1 ORDER BY created_at ASC NULLS LAST, id ASC LIMIT 1`, [groupId]);
    if (existing.rowCount)
        return existing.rows[0].id;
    // nincs → létrehozunk alapértelmezettet
    const id = (0, crypto_1.randomUUID)();
    await client.query(`INSERT INTO product_categories (id, product_group_id, name_hu, name_en, name_ru)
     VALUES ($1,$2,$3,$4,$5)`, [id, groupId, "Egyéb", "Other", "Другое"]);
    return id;
}
// régi helper: ha explicitGroupId nincs, az első csoportot keresi.
// Most már: ha nincs, létrehozunk is egyet.
async function resolveProductGroupId(explicitGroupId) {
    const client = await db_1.default.connect();
    try {
        await client.query("BEGIN");
        await ensureTaxonomyTables(client);
        const gid = await ensureGroupId(client, explicitGroupId);
        await client.query("COMMIT");
        return gid;
    }
    catch (e) {
        await client.query("ROLLBACK");
        throw e;
    }
    finally {
        client.release();
    }
}
// =========================
//  FÁJL FELTÖLTÉS BEÁLLÍTÁS
// =========================
const uploadDir = path_1.default.join(__dirname, "..", "..", "uploads", "products");
if (!fs_1.default.existsSync(uploadDir)) {
    fs_1.default.mkdirSync(uploadDir, { recursive: true });
}
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => {
        cb(null, uploadDir);
    },
    filename: (_req, file, cb) => {
        const safeOriginalName = file.originalname.replace(/\s+/g, "_");
        const ext = path_1.default.extname(safeOriginalName);
        const base = path_1.default.basename(safeOriginalName, ext);
        const unique = Date.now().toString(36);
        cb(null, `${base}-${unique}${ext}`);
    },
});
const upload = (0, multer_1.default)({ storage });
// =========================
//  HELPER FÜGGVÉNYEK
// =========================
function toNumber(value) {
    if (value === null || value === undefined || value === "")
        return null;
    const n = Number(String(value).replace(",", "."));
    return Number.isNaN(n) ? null : n;
}
/**
 * Ha nincs product_group_id a kérésben, megpróbálunk
 * egy alapértelmezett csoportot választani.
 */
router.get("/products", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT
        id,
        name,
        retail_price_gross,
        sale_price,
        web_is_visible,
        is_retail,
        web_sort_order,
        web_description,
        image_url,
        product_group_id,
        main_category,
        sub_category,
        service_category
      FROM products
      ORDER BY COALESCE(web_sort_order, 9999), name
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list products error:", err);
        return res.status(500).send("Hiba a termékek listázásakor.");
    }
});
/**
 * =========================
 *  TERMÉKCSOPORTOK (GROUPS)
 * =========================
 * Többnyelvű: name_hu, name_en, name_ru
 * Aliasok: /product_groups, /groups, /product-groups
 */
const groupPaths = ["/product-groups", "/product_groups", "/groups"];
groupPaths.forEach((p) => {
    router.get(p, async (_req, res) => {
        try {
            const client = await db_1.default.connect();
            try {
                await client.query("BEGIN");
                await ensureTaxonomyTables(client);
                const r = await client.query(`SELECT id, name_hu, name_en, name_ru FROM product_groups ORDER BY created_at ASC NULLS LAST, id ASC`);
                await client.query("COMMIT");
                return res.json(r.rows);
            }
            catch (e) {
                await client.query("ROLLBACK");
                throw e;
            }
            finally {
                client.release();
            }
        }
        catch (err) {
            console.error("❌ Admin product-groups list error:", err);
            return res.status(500).send("Hiba a termékcsoportok listázásakor.");
        }
    });
    router.post(p, async (req, res) => {
        try {
            const { id, name_hu, name_en, name_ru } = req.body || {};
            const gid = (id ? String(id).trim() : (0, crypto_1.randomUUID)());
            const client = await db_1.default.connect();
            try {
                await client.query("BEGIN");
                await ensureTaxonomyTables(client);
                await client.query(`INSERT INTO product_groups (id, name_hu, name_en, name_ru)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (id) DO UPDATE SET
             name_hu=EXCLUDED.name_hu,
             name_en=EXCLUDED.name_en,
             name_ru=EXCLUDED.name_ru`, [
                    gid,
                    String(name_hu || "Új csoport"),
                    name_en !== undefined ? String(name_en) : null,
                    name_ru !== undefined ? String(name_ru) : null,
                ]);
                const out = await client.query(`SELECT id, name_hu, name_en, name_ru FROM product_groups WHERE id=$1`, [gid]);
                await client.query("COMMIT");
                return res.status(201).json(out.rows[0]);
            }
            catch (e) {
                await client.query("ROLLBACK");
                throw e;
            }
            finally {
                client.release();
            }
        }
        catch (err) {
            console.error("❌ Admin product-groups create error:", err);
            return res.status(500).send("Hiba a termékcsoport létrehozásakor.");
        }
    });
});
/**
 * ===========================
 *  KATEGÓRIÁK (CATEGORIES)
 * ===========================
 * Többnyelvű: name_hu, name_en, name_ru
 * Kötelező: product_group_id
 * Aliasok: /product_categories, /categories, /product-categories
 */
const categoryPaths = [
    "/product-categories",
    "/product_categories",
    "/categories",
];
categoryPaths.forEach((p) => {
    router.get(p, async (req, res) => {
        try {
            const groupId = (req.query.product_group_id ||
                req.query.group_id ||
                "");
            const client = await db_1.default.connect();
            try {
                await client.query("BEGIN");
                await ensureTaxonomyTables(client);
                const r = groupId
                    ? await client.query(`SELECT id, product_group_id, name_hu, name_en, name_ru
               FROM product_categories
               WHERE product_group_id=$1
               ORDER BY created_at ASC NULLS LAST, id ASC`, [String(groupId)])
                    : await client.query(`SELECT id, product_group_id, name_hu, name_en, name_ru
               FROM product_categories
               ORDER BY created_at ASC NULLS LAST, id ASC`);
                await client.query("COMMIT");
                return res.json(r.rows);
            }
            catch (e) {
                await client.query("ROLLBACK");
                throw e;
            }
            finally {
                client.release();
            }
        }
        catch (err) {
            console.error("❌ Admin product-categories list error:", err);
            return res.status(500).send("Hiba a kategóriák listázásakor.");
        }
    });
    router.post(p, async (req, res) => {
        try {
            const { id, product_group_id, group_id, name_hu, name_en, name_ru } = req.body || {};
            const pid = product_group_id || group_id;
            const client = await db_1.default.connect();
            try {
                await client.query("BEGIN");
                await ensureTaxonomyTables(client);
                const gid = await ensureGroupId(client, pid);
                const cid = (id ? String(id).trim() : (0, crypto_1.randomUUID)());
                await client.query(`INSERT INTO product_categories (id, product_group_id, name_hu, name_en, name_ru)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (id) DO UPDATE SET
             product_group_id=EXCLUDED.product_group_id,
             name_hu=EXCLUDED.name_hu,
             name_en=EXCLUDED.name_en,
             name_ru=EXCLUDED.name_ru`, [
                    cid,
                    gid,
                    String(name_hu || "Új kategória"),
                    name_en !== undefined ? String(name_en) : null,
                    name_ru !== undefined ? String(name_ru) : null,
                ]);
                const out = await client.query(`SELECT id, product_group_id, name_hu, name_en, name_ru FROM product_categories WHERE id=$1`, [cid]);
                await client.query("COMMIT");
                return res.status(201).json(out.rows[0]);
            }
            catch (e) {
                await client.query("ROLLBACK");
                throw e;
            }
            finally {
                client.release();
            }
        }
        catch (err) {
            console.error("❌ Admin product-categories create error:", err);
            return res.status(500).send("Hiba a kategória létrehozásakor.");
        }
    });
});
/**
 * POST /api/admin/webshop/products
 * Új termék létrehozása.
 */
router.post("/products", async (req, res) => {
    const client = await db_1.default.connect();
    try {
        await client.query("BEGIN");
        await ensureTaxonomyTables(client);
        // Többféle front kompatibilitás:
        // - name / name_hu|en|ru
        // - group_id / product_group_id
        // - category_id / product_category_id
        const body = req.body || {};
        const name = body.name ?? body.name_hu ?? "";
        if (!String(name).trim()) {
            await client.query("ROLLBACK");
            return res.status(400).send("A terméknév kötelező.");
        }
        const retailPrice = body.retail_price_gross !== undefined ? toNumber(body.retail_price_gross) : null;
        const salePrice = body.sale_price !== undefined ? toNumber(body.sale_price) : null;
        const sortOrder = toNumber(body.web_sort_order);
        const visible = typeof body.web_is_visible === "boolean" ? body.web_is_visible : true;
        const retail = typeof body.is_retail === "boolean" ? body.is_retail : true;
        const explicitGroup = body.product_group_id ?? body.group_id ?? null;
        const explicitCategory = body.product_category_id ?? body.category_id ?? null;
        const resolvedGroupId = await ensureGroupId(client, explicitGroup);
        const resolvedCategoryId = await ensureCategoryId(client, resolvedGroupId, explicitCategory);
        // location_id: ha van oszlop, és van user-ben / body-ban, kitöltjük
        const locationId = (body.location_id ? String(body.location_id) : null) ||
            (req.user?.location_id ? String(req.user.location_id) : null);
        // Dinamikus INSERT: csak a létező oszlopokat használjuk
        const cols = [
            "name",
            "retail_price_gross",
            "sale_price",
            "web_is_visible",
            "is_retail",
            "web_sort_order",
            "web_description",
            "product_group_id",
            "main_category",
            "sub_category",
            "service_category",
        ];
        const vals = [
            String(name).trim(),
            retailPrice,
            salePrice,
            visible,
            retail,
            sortOrder,
            body.web_description ?? null,
            resolvedGroupId,
            body.main_category ?? null,
            body.sub_category ?? null,
            body.service_category ?? null,
        ];
        // product_category_id
        if (await hasColumn(client, "products", "product_category_id")) {
            cols.push("product_category_id");
            vals.push(resolvedCategoryId);
        }
        // location_id
        if (await hasColumn(client, "products", "location_id")) {
            cols.push("location_id");
            vals.push(locationId);
        }
        // többnyelvű mezők
        if (await hasColumn(client, "products", "name_hu")) {
            cols.push("name_hu");
            vals.push(body.name_hu ?? (body.lang === "hu" ? name : null) ?? null);
        }
        if (await hasColumn(client, "products", "name_en")) {
            cols.push("name_en");
            vals.push(body.name_en ?? null);
        }
        if (await hasColumn(client, "products", "name_ru")) {
            cols.push("name_ru");
            vals.push(body.name_ru ?? null);
        }
        if (await hasColumn(client, "products", "web_description_hu")) {
            cols.push("web_description_hu");
            vals.push(body.web_description_hu ?? null);
        }
        if (await hasColumn(client, "products", "web_description_en")) {
            cols.push("web_description_en");
            vals.push(body.web_description_en ?? null);
        }
        if (await hasColumn(client, "products", "web_description_ru")) {
            cols.push("web_description_ru");
            vals.push(body.web_description_ru ?? null);
        }
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
        const q = `
      INSERT INTO products (${cols.join(", ")})
      VALUES (${placeholders})
      RETURNING *
    `;
        const result = await client.query(q, vals);
        await client.query("COMMIT");
        return res.status(201).json(result.rows[0]);
    }
    catch (err) {
        try {
            await client.query("ROLLBACK");
        }
        catch { }
        console.error("❌ Admin create product error:", err);
        if (err?.code === "23502") {
            const col = err?.column ? String(err.column) : "ismeretlen mező";
            return res.status(400).send(`Hiányzó kötelező mező: ${col}`);
        }
        if (err?.code === "23503") {
            return res.status(400).send("Érvénytelen hivatkozás (csoport/kategória).");
        }
        return res.status(500).send("Hiba a termék létrehozásakor.");
    }
    finally {
        client.release();
    }
});
/**
 * PUT /api/admin/webshop/products/:id
 * Termék frissítése.
 */
router.put("/products/:id", async (req, res) => {
    const client = await db_1.default.connect();
    try {
        await client.query("BEGIN");
        await ensureTaxonomyTables(client);
        const { id } = req.params;
        const body = req.body || {};
        // meglévő termék lekérése (hogy ha nincs megadva csoport/kategória, megtartsuk)
        const existing = await client.query(`SELECT * FROM products WHERE id=$1`, [id]);
        if (!existing.rowCount) {
            await client.query("ROLLBACK");
            return res.status(404).send("A termék nem található.");
        }
        const current = existing.rows[0];
        // Field presence (különbség: undefined vs null)
        const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
        const name = has("name") ? body.name : current.name;
        const name_hu = has("name_hu") ? body.name_hu : current.name_hu;
        const name_en = has("name_en") ? body.name_en : current.name_en;
        const name_ru = has("name_ru") ? body.name_ru : current.name_ru;
        const retailPrice = has("retail_price_gross")
            ? toNumber(body.retail_price_gross)
            : current.retail_price_gross;
        const salePrice = has("sale_price") ? toNumber(body.sale_price) : current.sale_price;
        const sortOrder = has("web_sort_order") ? toNumber(body.web_sort_order) : current.web_sort_order;
        const visible = has("web_is_visible")
            ? (typeof body.web_is_visible === "boolean" ? body.web_is_visible : !!current.web_is_visible)
            : current.web_is_visible;
        const retail = has("is_retail")
            ? (typeof body.is_retail === "boolean" ? body.is_retail : !!current.is_retail)
            : current.is_retail;
        const webDesc = has("web_description") ? body.web_description : current.web_description;
        const explicitGroup = has("product_group_id") ? body.product_group_id : (has("group_id") ? body.group_id : undefined);
        const explicitCategory = has("product_category_id") ? body.product_category_id : (has("category_id") ? body.category_id : undefined);
        let groupId = current.product_group_id;
        if (explicitGroup !== undefined) {
            groupId = await ensureGroupId(client, explicitGroup);
        }
        let categoryId = current.product_category_id ?? null;
        if (await hasColumn(client, "products", "product_category_id")) {
            if (explicitCategory !== undefined || explicitGroup !== undefined) {
                // ha group változott, a kategóriát is validáljuk a group alatt
                categoryId = await ensureCategoryId(client, groupId, explicitCategory);
            }
            else if (!categoryId) {
                categoryId = await ensureCategoryId(client, groupId, null);
            }
        }
        // location_id: ha van oszlop, ne írjuk felül, csak ha explicit
        const locationId = has("location_id")
            ? (body.location_id ? String(body.location_id) : null)
            : current.location_id;
        const cols = [];
        const vals = [];
        const push = (col, v) => {
            cols.push(`${col}=$${vals.length + 1}`);
            vals.push(v);
        };
        // kötelező/gyakori mezők
        push("name", String(name ?? "").trim());
        push("retail_price_gross", retailPrice);
        push("sale_price", salePrice);
        push("web_is_visible", visible);
        push("is_retail", retail);
        push("web_sort_order", sortOrder);
        push("web_description", webDesc ?? null);
        push("product_group_id", groupId);
        // régi kategória string mezők (ha léteznek a sémában, itt hagyjuk)
        push("main_category", has("main_category") ? body.main_category : current.main_category);
        push("sub_category", has("sub_category") ? body.sub_category : current.sub_category);
        push("service_category", has("service_category") ? body.service_category : current.service_category);
        if (await hasColumn(client, "products", "product_category_id")) {
            push("product_category_id", categoryId);
        }
        if (await hasColumn(client, "products", "location_id")) {
            push("location_id", locationId);
        }
        // többnyelvű mezők
        if (await hasColumn(client, "products", "name_hu"))
            push("name_hu", name_hu ?? null);
        if (await hasColumn(client, "products", "name_en"))
            push("name_en", name_en ?? null);
        if (await hasColumn(client, "products", "name_ru"))
            push("name_ru", name_ru ?? null);
        if (await hasColumn(client, "products", "web_description_hu"))
            push("web_description_hu", has("web_description_hu") ? body.web_description_hu : current.web_description_hu);
        if (await hasColumn(client, "products", "web_description_en"))
            push("web_description_en", has("web_description_en") ? body.web_description_en : current.web_description_en);
        if (await hasColumn(client, "products", "web_description_ru"))
            push("web_description_ru", has("web_description_ru") ? body.web_description_ru : current.web_description_ru);
        const q = `
      UPDATE products
      SET ${cols.join(", ")}
      WHERE id=$${vals.length + 1}
      RETURNING *
    `;
        vals.push(id);
        const updated = await client.query(q, vals);
        await client.query("COMMIT");
        return res.json(updated.rows[0]);
    }
    catch (err) {
        try {
            await client.query("ROLLBACK");
        }
        catch { }
        console.error("❌ Admin update product error:", err);
        if (err?.code === "23502") {
            const col = err?.column ? String(err.column) : "ismeretlen mező";
            return res.status(400).send(`Hiányzó kötelező mező: ${col}`);
        }
        return res.status(500).send("Hiba a termék módosításakor.");
    }
    finally {
        client.release();
    }
});
/**
 * DELETE /api/admin/webshop/products/:id
 * Termék törlése.
 */
router.delete("/products/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.default.query(`DELETE FROM products WHERE id = $1 RETURNING id`, [id]);
        if (!result.rows.length) {
            return res.status(404).send("A termék nem található.");
        }
        return res.json({ status: "ok" });
    }
    catch (err) {
        console.error("❌ Admin delete product error:", err);
        return res.status(500).send("Hiba a termék törlésekor.");
    }
});
/**
 * POST /api/admin/webshop/products/:id/image
 * Termékkép feltöltése.
 */
router.post("/products/:id/image", upload.single("file"), async (req, res) => {
    try {
        const { id } = req.params;
        const file = req.file;
        if (!file) {
            return res.status(400).send("Nem érkezett fájl.");
        }
        const publicUrl = `/uploads/products/${file.filename}`;
        await db_1.default.query(`UPDATE products SET image_url = $2 WHERE id = $1`, [id, publicUrl]);
        return res.json({
            status: "ok",
            image_url: publicUrl,
        });
    }
    catch (err) {
        console.error("❌ Admin upload product image error:", err);
        return res.status(500).send("Hiba a kép feltöltésekor.");
    }
});
// =========================
//  KUPONOK
// =========================
/**
 * GET /api/admin/webshop/coupons
 */
router.get("/coupons", async (_req, res) => {
    try {
        const result = await db_1.default.query(`SELECT * FROM coupons ORDER BY created_at DESC`);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list coupons error:", err);
        return res.status(500).send("Hiba a kuponok listázásakor.");
    }
});
/**
 * POST /api/admin/webshop/coupons
 */
router.post("/coupons", async (req, res) => {
    try {
        const { code, description, discount_type, discount_value, min_order_total, max_discount_value, valid_from, valid_until, usage_limit, is_active, } = req.body || {};
        if (!code || !discount_value) {
            return res
                .status(400)
                .send("Kuponkód és kedvezmény értéke kötelező.");
        }
        const result = await db_1.default.query(`
      INSERT INTO coupons (
        code,
        description,
        discount_type,
        discount_value,
        min_order_total,
        max_discount_value,
        valid_from,
        valid_until,
        usage_limit,
        usage_count,
        is_active
      )
      VALUES (
        $1,
        $2,
        COALESCE($3, 'percent'),
        $4,
        COALESCE($5, 0),
        $6,
        $7,
        $8,
        $9,
        0,
        COALESCE($10, true)
      )
      RETURNING *
      `, [
            String(code).trim().toUpperCase(),
            description || null,
            discount_type || null,
            toNumber(discount_value),
            toNumber(min_order_total),
            toNumber(max_discount_value),
            valid_from || null,
            valid_until || null,
            usage_limit !== undefined ? Number(usage_limit) : null,
            typeof is_active === "boolean" ? is_active : true,
        ]);
        return res.status(201).json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin create coupon error:", err);
        return res.status(500).send("Hiba a kupon létrehozásakor.");
    }
});
/**
 * PUT /api/admin/webshop/coupons/:id
 */
router.put("/coupons/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { description, discount_type, discount_value, min_order_total, max_discount_value, valid_from, valid_until, usage_limit, is_active, } = req.body || {};
        const result = await db_1.default.query(`
      UPDATE coupons
      SET
        description = COALESCE($2, description),
        discount_type = COALESCE($3, discount_type),
        discount_value = COALESCE($4, discount_value),
        min_order_total = COALESCE($5, min_order_total),
        max_discount_value = COALESCE($6, max_discount_value),
        valid_from = COALESCE($7, valid_from),
        valid_until = COALESCE($8, valid_until),
        usage_limit = COALESCE($9, usage_limit),
        is_active = COALESCE($10, is_active)
      WHERE id = $1
      RETURNING *
      `, [
            id,
            description !== undefined ? description : null,
            discount_type !== undefined ? discount_type : null,
            discount_value !== undefined ? toNumber(discount_value) : null,
            min_order_total !== undefined ? toNumber(min_order_total) : null,
            max_discount_value !== undefined
                ? toNumber(max_discount_value)
                : null,
            valid_from !== undefined ? valid_from : null,
            valid_until !== undefined ? valid_until : null,
            usage_limit !== undefined ? Number(usage_limit) : null,
            typeof is_active === "boolean" ? is_active : null,
        ]);
        if (!result.rows.length) {
            return res.status(404).send("A kupon nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update coupon error:", err);
        return res.status(500).send("Hiba a kupon frissítésekor.");
    }
});
/**
 * DELETE /api/admin/webshop/coupons/:id
 */
router.delete("/coupons/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.default.query(`DELETE FROM coupons WHERE id = $1 RETURNING id`, [id]);
        if (!result.rows.length) {
            return res.status(404).send("A kupon nem található.");
        }
        return res.json({ status: "ok" });
    }
    catch (err) {
        console.error("❌ Admin delete coupon error:", err);
        return res.status(500).send("Hiba a kupon törlésekor.");
    }
});
// =========================
//  RENDELÉSEK
// =========================
/**
 * GET /api/admin/webshop/orders
 */
router.get("/orders", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT
        id,
        created_at,
        customer_full_name AS customer_name,
        customer_email,
        customer_phone,
        subtotal_gross,
        discount_gross,
        total_gross,
        currency,
        payment_method,
        status,
        payment_status,
        coupon_code
      FROM webshop_orders
      ORDER BY created_at DESC
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list orders error:", err);
        return res.status(500).send("Hiba a rendelések listázásakor.");
    }
});
/**
 * GET /api/admin/webshop/orders/:id
 */
router.get("/orders/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.default.query(`
      SELECT
        id,
        created_at,
        customer_full_name AS customer_name,
        customer_email,
        customer_phone,
        subtotal_gross,
        discount_gross,
        total_gross,
        currency,
        payment_method,
        status,
        payment_status,
        coupon_code
      FROM webshop_orders
      WHERE id = $1
      `, [id]);
        if (!result.rows.length) {
            return res.status(404).send("A rendelés nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin get order error:", err);
        return res.status(500).send("Hiba a rendelés betöltésekor.");
    }
});
/**
 * PUT /api/admin/webshop/orders/:id
 * (tipikusan státusz, fizetési státusz frissítése)
 */
router.put("/orders/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { status, payment_status } = req.body || {};
        const result = await db_1.default.query(`
      UPDATE webshop_orders
      SET
        status = COALESCE($2, status),
        payment_status = COALESCE($3, payment_status)
      WHERE id = $1
      RETURNING *
      `, [id, status || null, payment_status || null]);
        if (!result.rows.length) {
            return res.status(404).send("A rendelés nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update order error:", err);
        return res.status(500).send("Hiba a rendelés frissítésekor.");
    }
});
// =========================
//  SZÁMLÁK
// =========================
/**
 * GET /api/admin/webshop/invoices
 */
router.get("/invoices", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT
        id,
        invoice_number,
        order_id,
        amount_gross,
        currency,
        pdf_url,
        created_at
      FROM webshop_invoices
      ORDER BY created_at DESC
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list invoices error:", err);
        return res.status(500).send("Hiba a számlák listázásakor.");
    }
});
router.patch("/orders/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { status, payment_status } = req.body || {};
        const result = await db_1.default.query(`
      UPDATE webshop_orders
      SET
        status = COALESCE($2, status),
        payment_status = COALESCE($3, payment_status)
      WHERE id = $1
      RETURNING *
      `, [id, status || null, payment_status || null]);
        if (!result.rows.length) {
            return res.status(404).send("A rendelés nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update order error:", err);
        return res.status(500).send("Hiba a rendelés frissítésekor.");
    }
});
// =========================
//  SZÁMLÁK
// =========================
/**
 * GET /api/admin/webshop/invoices
 */
router.get("/invoices", async (_req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT
        id,
        invoice_number,
        order_id,
        amount_gross,
        currency,
        pdf_url,
        created_at
      FROM webshop_invoices
      ORDER BY created_at DESC
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Admin list invoices error:", err);
        return res.status(500).send("Hiba a számlák listázásakor.");
    }
});
/**
 * GET /api/admin/webshop/invoices/:id
 */
router.get("/invoices/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const result = await db_1.default.query(`
      SELECT
        id,
        invoice_number,
        order_id,
        amount_gross,
        currency,
        pdf_url,
        created_at
      FROM webshop_invoices
      WHERE id = $1
      `, [id]);
        if (!result.rows.length) {
            return res.status(404).send("A számla nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin get invoice error:", err);
        return res.status(500).send("Hiba a számla betöltésekor.");
    }
});
/**
 * POST /api/admin/webshop/invoices
 * Egyszerű számlarögzítés (külső számlázó után).
 */
router.post("/invoices", async (req, res) => {
    try {
        const { invoice_number, order_id, amount_gross, currency, pdf_url } = req.body || {};
        if (!invoice_number || !order_id) {
            return res
                .status(400)
                .send("Számlaszám és rendelés azonosító kötelező.");
        }
        const result = await db_1.default.query(`
      INSERT INTO webshop_invoices (
        invoice_number,
        order_id,
        amount_gross,
        currency,
        pdf_url
      )
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
      `, [
            String(invoice_number).trim(),
            order_id,
            toNumber(amount_gross),
            currency || "HUF",
            pdf_url || null,
        ]);
        return res.status(201).json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin create invoice error:", err);
        return res.status(500).send("Hiba a számla létrehozásakor.");
    }
});
/**
 * PUT /api/admin/webshop/invoices/:id
 */
router.put("/invoices/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { invoice_number, amount_gross, currency, pdf_url } = req.body || {};
        const result = await db_1.default.query(`
      UPDATE webshop_invoices
      SET
        invoice_number = COALESCE($2, invoice_number),
        amount_gross = COALESCE($3, amount_gross),
        currency = COALESCE($4, currency),
        pdf_url = COALESCE($5, pdf_url)
      WHERE id = $1
      RETURNING *
      `, [
            id,
            invoice_number !== undefined
                ? String(invoice_number).trim()
                : null,
            amount_gross !== undefined ? toNumber(amount_gross) : null,
            currency !== undefined ? currency : null,
            pdf_url !== undefined ? pdf_url : null,
        ]);
        if (!result.rows.length) {
            return res.status(404).send("A számla nem található.");
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Admin update invoice error:", err);
        return res.status(500).send("Hiba a számla frissítésekor.");
    }
});
exports.default = router;
