"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listProfessionalsAvailable = listProfessionalsAvailable;
exports.listProfessionals = listProfessionals;
exports.createProfessional = createProfessional;
exports.updateProfessional = updateProfessional;
exports.deleteProfessional = deleteProfessional;
async function listProfessionalsAvailable(pool) {
    const { rows } = await pool.query(`SELECT * FROM signage_professionals
     WHERE available = true
     ORDER BY priority DESC, updated_at DESC`);
    return rows;
}
async function listProfessionals(pool) {
    const { rows } = await pool.query(`SELECT * FROM signage_professionals
     ORDER BY available DESC, priority DESC, updated_at DESC`);
    return rows;
}
async function createProfessional(pool, input) {
    const { rows } = await pool.query(`INSERT INTO signage_professionals (name, title, note, photo_url, available, priority)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING *`, [
        input.name,
        input.title ?? "",
        input.note ?? "",
        input.photo_url ?? "",
        input.available ?? true,
        input.priority ?? 0,
    ]);
    return rows[0];
}
async function updateProfessional(pool, id, input) {
    const fields = [];
    const vals = [];
    let i = 1;
    const push = (k, v) => { fields.push(`${k} = $${i++}`); vals.push(v); };
    if (input.name !== undefined)
        push("name", input.name);
    if (input.title !== undefined)
        push("title", input.title);
    if (input.note !== undefined)
        push("note", input.note);
    if (input.photo_url !== undefined)
        push("photo_url", input.photo_url);
    if (input.available !== undefined)
        push("available", input.available);
    if (input.priority !== undefined)
        push("priority", input.priority);
    if (fields.length === 0) {
        const { rows } = await pool.query(`SELECT * FROM signage_professionals WHERE id=$1`, [id]);
        return rows[0] || null;
    }
    vals.push(id);
    const { rows } = await pool.query(`UPDATE signage_professionals SET ${fields.join(", ")}, updated_at = now()
     WHERE id = $${i}
     RETURNING *`, vals);
    return rows[0] || null;
}
async function deleteProfessional(pool, id) {
    const { rowCount } = await pool.query(`DELETE FROM signage_professionals WHERE id=$1`, [id]);
    return (rowCount ?? 0) > 0;
}
