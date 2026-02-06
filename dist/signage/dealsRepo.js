"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listDeals = listDeals;
exports.listDealsForToday = listDealsForToday;
exports.createDeal = createDeal;
exports.updateDeal = updateDeal;
exports.deleteDeal = deleteDeal;
async function listDeals(pool) {
    const { rows } = await pool.query(`SELECT * FROM signage_deals ORDER BY active DESC, priority DESC, updated_at DESC`);
    return rows;
}
async function listDealsForToday(pool) {
    const { rows } = await pool.query(`SELECT * FROM signage_deals
     WHERE active = true
       AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
       AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)
     ORDER BY priority DESC, updated_at DESC`);
    return rows;
}
async function createDeal(pool, input) {
    const { rows } = await pool.query(`INSERT INTO signage_deals (title, subtitle, price_text, valid_from, valid_to, active, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING *`, [
        input.title,
        input.subtitle ?? "",
        input.price_text ?? "",
        input.valid_from ?? null,
        input.valid_to ?? null,
        input.active ?? true,
        input.priority ?? 0,
    ]);
    return rows[0];
}
async function updateDeal(pool, id, input) {
    const fields = [];
    const vals = [];
    let i = 1;
    const push = (k, v) => { fields.push(`${k} = $${i++}`); vals.push(v); };
    if (input.title !== undefined)
        push("title", input.title);
    if (input.subtitle !== undefined)
        push("subtitle", input.subtitle);
    if (input.price_text !== undefined)
        push("price_text", input.price_text);
    if (input.valid_from !== undefined)
        push("valid_from", input.valid_from);
    if (input.valid_to !== undefined)
        push("valid_to", input.valid_to);
    if (input.active !== undefined)
        push("active", input.active);
    if (input.priority !== undefined)
        push("priority", input.priority);
    if (fields.length === 0) {
        const { rows } = await pool.query(`SELECT * FROM signage_deals WHERE id=$1`, [id]);
        return rows[0] || null;
    }
    vals.push(id);
    const { rows } = await pool.query(`UPDATE signage_deals SET ${fields.join(", ")}, updated_at = now()
     WHERE id = $${i}
     RETURNING *`, vals);
    return rows[0] || null;
}
async function deleteDeal(pool, id) {
    const { rowCount } = await pool.query(`DELETE FROM signage_deals WHERE id=$1`, [id]);
    return (rowCount ?? 0) > 0;
}
