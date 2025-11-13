"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db"));
const router = express_1.default.Router();
// === GET ALL EVENTS ===
router.get("/", async (req, res) => {
    try {
        const result = await db_1.default.query(`
      SELECT e.*, emp.name AS employee_name, c.name AS client_name, s.name AS service_name
      FROM events e
      LEFT JOIN employees emp ON emp.id = e.employee_id
      LEFT JOIN clients c ON c.id = e.client_id
      LEFT JOIN services s ON s.id = e.service_id
      ORDER BY e.start_time ASC
    `);
        res.json(result.rows);
    }
    catch (err) {
        console.error("❌ Error fetching events:", err);
        res.status(500).json({ error: "Error fetching events" });
    }
});
// === GET SINGLE EVENT ===
router.get("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        const result = await db_1.default.query("SELECT * FROM events WHERE id = $1", [id]);
        res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Error fetching event:", err);
        res.status(500).json({ error: "Error fetching event" });
    }
});
// === CREATE NEW EVENT ===
router.post("/", async (req, res) => {
    const { title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes, } = req.body;
    try {
        const result = await db_1.default.query(`INSERT INTO events 
       (title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`, [title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes]);
        res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Error creating event:", err);
        res.status(500).json({ error: "Error creating event" });
    }
});
// === UPDATE EVENT ===
router.put("/:id", async (req, res) => {
    const { id } = req.params;
    const { title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes, } = req.body;
    try {
        const result = await db_1.default.query(`UPDATE events SET 
        title=$1, employee_id=$2, client_id=$3, service_id=$4, 
        start_time=$5, end_time=$6, status=$7, price=$8, payment_method=$9, notes=$10
       WHERE id=$11 RETURNING *`, [title, employee_id, client_id, service_id, start_time, end_time, status, price, payment_method, notes, id]);
        res.json(result.rows[0]);
    }
    catch (err) {
        console.error("❌ Error updating event:", err);
        res.status(500).json({ error: "Error updating event" });
    }
});
// === DELETE EVENT ===
router.delete("/:id", async (req, res) => {
    const { id } = req.params;
    try {
        await db_1.default.query("DELETE FROM events WHERE id=$1", [id]);
        res.sendStatus(204);
    }
    catch (err) {
        console.error("❌ Error deleting event:", err);
        res.status(500).json({ error: "Error deleting event" });
    }
});
exports.default = router;
