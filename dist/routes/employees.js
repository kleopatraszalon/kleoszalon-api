"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// backend/src/routes/employees.ts
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const router = express_1.default.Router();
/* ==========================================================
   AUTH MIDDLEWARE
   - Authorization: Bearer <token>
   - token payload pl.: { user_id: "...", role: "admin" }
========================================================== */
function authenticate(req, res, next) {
    const auth = req.headers.authorization;
    if (!auth) {
        return res.status(401).json({ error: "Nincs token" });
    }
    try {
        const token = auth.split(" ")[1];
        const decoded = jsonwebtoken_1.default.verify(token, process.env.JWT_SECRET);
        req.user = decoded; // { user_id, role, ... }
        next();
    }
    catch (err) {
        console.error("JWT hiba:", err);
        return res.status(403).json({ error: "Érvénytelen token" });
    }
}
/* ==========================================================
   ROLE CHECK: lista lekéréséhez
   - admin
   - receptionist
   - employee (szakember)
   vendég NE lássa
========================================================== */
function authorizeEmployeeList(req, res, next) {
    const role = req.user?.role;
    if (!role) {
        return res
            .status(403)
            .json({ error: "Nincs jogosultság (nincs szerepkör)" });
    }
    const allowed = ["admin", "receptionist", "employee"];
    if (!allowed.includes(role)) {
        return res
            .status(403)
            .json({ error: "Nincs jogosultság ehhez az erőforráshoz" });
    }
    next();
}
/* ==========================================================
   ROLE CHECK: adott dolgozó részletes adata
   - admin, receptionist: mindent láthat
   - employee: csak saját magát
========================================================== */
function authorizeEmployeeDetails(req, res, next) {
    const role = req.user?.role;
    const currentUserId = req.user?.user_id; // tedd bele ezt a tokenbe
    const requestedId = req.params.id;
    if (!role) {
        return res
            .status(403)
            .json({ error: "Nincs jogosultság (nincs szerepkör)" });
    }
    if (role === "admin" || role === "receptionist") {
        return next();
    }
    if (role === "employee") {
        if (currentUserId === requestedId) {
            return next();
        }
        else {
            return res
                .status(403)
                .json({ error: "Nem férhetsz hozzá más dolgozó adatlapjához" });
        }
    }
    return res
        .status(403)
        .json({ error: "Nincs jogosultság ehhez az erőforráshoz" });
}
/* ==========================================================
   ROLE CHECK: admin-only műveletek
   - státuszváltás
   - új dolgozó létrehozás
   - credentials módosítás
   - roles módosítás
========================================================== */
function requireAdmin(req, res, next) {
    if (req.user?.role !== "admin") {
        return res.status(403).json({ error: "Nincs jogosultság (csak admin)." });
    }
    next();
}
/* ==========================================================
   GET /api/employees
   Dolgozók listája.
   query param: ?include_inactive=1   -> akkor NEM szűrünk active=true-re
   FRONTEND: EmployeesList.tsx ezt használja
========================================================== */
router.get("/", authenticate, authorizeEmployeeList, async (req, res) => {
    try {
        const includeInactive = req.query.include_inactive === "1";
        const result = await db_1.default.query(`
      SELECT
        e.id,
        e.full_name,
        e.first_name,
        e.last_name,
        e.birth_date,
        e.qualification,
        e.monthly_wage,
        e.hourly_wage,
        e.photo_url,
        e.location_id,
        e.active,
        l.name AS location_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      ${includeInactive ? "" : "WHERE e.active = true"}
      ORDER BY e.last_name, e.first_name;
      `);
        return res.json(result.rows);
    }
    catch (err) {
        console.error("❌ /api/employees hiba:", err);
        return res
            .status(500)
            .json({ error: "Adatbázis hiba a dolgozók listázásánál" });
    }
});
/* ==========================================================
   GET /api/employees/:id
   Egy dolgozó teljes profilja (HR adatlap)
========================================================== */
router.get("/:id", authenticate, authorizeEmployeeDetails, async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db_1.default.query(`
      SELECT
        e.id,
        e.location_id,
        l.name AS location_name,

        e.full_name,
        e.first_name,
        e.last_name,
        e.active,

        e.role,                 -- JSON-ben tárolt szerepkörlista pl. ["admin","recepciós"]

        e.birth_name,
        e.birth_date,
        e.birth_country,
        e.birth_region,
        e.birth_city,
        e.nationality,
        e.gender,
        e.mother_name,

        e.taj_number,
        e.tax_id,

        e.qualification,
        e.work_schedule_type,
        e.work_schedule_type_id,
        e.employment_type,
        e.employment_type_id,

        e.hourly_rate,
        e.hourly_wage,
        e.monthly_wage,

        e.photo_url,
        e.bio,
        e.color,

        e.department_id,
        e.position_id,

        e.notes,
        e.review_notes,
        e.traits,

        e.created_at,

        e.login_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.id = $1
      LIMIT 1;
      `, [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Dolgozó nem található" });
        }
        return res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ /api/employees/:id hiba:", err);
        return res
            .status(500)
            .json({ error: "Adatbázis hiba a dolgozó lekérésénél" });
    }
});
/* ==========================================================
   POST /api/employees
   ÚJ dolgozó létrehozása
========================================================== */
router.post("/", authenticate, requireAdmin, async (req, res) => {
    const { first_name, last_name, full_name, phone, email, birth_date, location_id, login_name, plain_password, roles, active, } = req.body;
    const computedFullName = full_name ||
        `${(last_name || "").trim()} ${(first_name || "").trim()}`.trim();
    if (!computedFullName ||
        !phone ||
        !login_name ||
        !plain_password ||
        !location_id) {
        return res.status(400).json({
            error: "Kötelező mező hiányzik (név / telefon / login / jelszó / telephely).",
        });
    }
    try {
        const hash = await bcrypt_1.default.hash(plain_password, 10);
        const insertResult = await db_1.default.query(`
      INSERT INTO employees (
        full_name,
        first_name,
        last_name,
        phone,
        email,
        birth_date,
        login_name,
        password_hash,
        location_id,
        role,
        active
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *
      `, [
            computedFullName,
            first_name || null,
            last_name || null,
            phone,
            email || null,
            birth_date || null,
            login_name,
            hash,
            location_id,
            JSON.stringify(roles || []),
            active === false ? false : true,
        ]);
        return res.status(201).json(insertResult.rows[0]);
    }
    catch (err) {
        console.error("❌ Új dolgozó mentési hiba:", err);
        return res.status(500).json({ error: "Adatbázis hiba létrehozáskor" });
    }
});
/* ==========================================================
   POST /api/employees/credentials
   Minimál user létrehozása
========================================================== */
router.post("/credentials", authenticate, requireAdmin, async (req, res) => {
    const { login_name, plain_password } = req.body;
    if (!login_name || !plain_password) {
        return res.status(400).json({
            error: "login_name és plain_password kötelező.",
        });
    }
    try {
        const hash = await bcrypt_1.default.hash(plain_password, 10);
        const r = await db_1.default.query(`
        INSERT INTO employees (login_name, password_hash, active)
        VALUES ($1,$2,true)
        RETURNING id, login_name, active
        `, [login_name.trim(), hash]);
        return res.status(201).json(r.rows[0]);
    }
    catch (err) {
        console.error("❌ Minimál user létrehozás hiba:", err);
        return res
            .status(500)
            .json({ error: "Adatbázis hiba user létrehozáskor." });
    }
});
/* ==========================================================
   PATCH /api/employees/:id/active
   Dolgozó aktiválása / inaktiválása
========================================================== */
router.patch("/:id/active", authenticate, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { active } = req.body;
    if (typeof active !== "boolean") {
        return res.status(400).json({
            error: "Hiányzik vagy hibás az 'active' mező (boolean kell).",
        });
    }
    try {
        const result = await db_1.default.query(`
        UPDATE employees
        SET active = $1
        WHERE id = $2
        RETURNING id, full_name, active
        `, [active, id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: "Nincs ilyen dolgozó." });
        }
        return res.json({
            success: true,
            employee: result.rows[0],
        });
    }
    catch (err) {
        console.error("❌ Dolgozó státusz frissítési hiba:", err);
        return res
            .status(500)
            .json({ error: "Adatbázis hiba státusz módosításkor." });
    }
});
/* ==========================================================
   PATCH /api/employees/:id/credentials
   Belépési adatok módosítása (admin)
========================================================== */
router.patch("/:id/credentials", authenticate, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { login_name, plain_password } = req.body;
    if (!login_name || !login_name.trim()) {
        return res
            .status(400)
            .json({ error: "A login_name kötelező a frissítéshez." });
    }
    try {
        let queryText = `
        UPDATE employees
        SET login_name = $1
        WHERE id = $2
        RETURNING id, full_name, login_name
      `;
        let queryParams = [login_name.trim(), id];
        if (plain_password && plain_password.trim()) {
            const hash = await bcrypt_1.default.hash(plain_password.trim(), 10);
            queryText = `
          UPDATE employees
          SET login_name = $1,
              password_hash = $2
          WHERE id = $3
          RETURNING id, full_name, login_name
        `;
            queryParams = [login_name.trim(), hash, id];
        }
        const upd = await db_1.default.query(queryText, queryParams);
        if (upd.rows.length === 0) {
            return res.status(404).json({ error: "Dolgozó nem található." });
        }
        return res.json({
            success: true,
            employee: upd.rows[0],
        });
    }
    catch (err) {
        console.error("❌ Belépési adatok frissítése hiba:", err);
        return res.status(500).json({
            error: "Adatbázis hiba belépési adatok frissítésekor.",
        });
    }
});
/* ==========================================================
   PATCH /api/employees/:id/roles
   Szerepkörök módosítása (admin)
========================================================== */
router.patch("/:id/roles", authenticate, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { roles } = req.body;
    if (!Array.isArray(roles)) {
        return res
            .status(400)
            .json({ error: "A roles mező kötelező és tömb kell legyen." });
    }
    try {
        const upd = await db_1.default.query(`
      UPDATE employees
      SET role = $1
      WHERE id = $2
      RETURNING id, full_name, role
      `, [JSON.stringify(roles), id]);
        if (upd.rows.length === 0) {
            return res.status(404).json({ error: "Dolgozó nem található." });
        }
        return res.json({
            success: true,
            employee: upd.rows[0],
        });
    }
    catch (err) {
        console.error("❌ Jogosultságok frissítése hiba:", err);
        return res.status(500).json({
            error: "Adatbázis hiba jogosultság frissítésekor.",
        });
    }
});
exports.default = router;
