"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listQuotes = listQuotes;
exports.listAllQuotes = listAllQuotes;
exports.createQuote = createQuote;
exports.updateQuote = updateQuote;
exports.deleteQuote = deleteQuote;
async function listQuotes(pool, category) {
    const params = [];
    let where = "WHERE active = true";
    if (category) {
        params.push(category);
        where += ` AND category = $${params.length}`;
    }
    const { rows } = await pool.query(`SELECT * FROM signage_quotes ${where} ORDER BY updated_at DESC`, params);
    return rows;
}
async function listAllQuotes(pool) {
    const { rows } = await pool.query(`SELECT * FROM signage_quotes ORDER BY active DESC, updated_at DESC`);
    return rows;
}
async function createQuote(pool, input) {
    const { rows } = await pool.query(`INSERT INTO signage_quotes (category, text, author, active)
     VALUES ($1,$2,$3,$4)
     RETURNING *`, [input.category, input.text, input.author ?? "", input.active ?? true]);
    return rows[0];
}
async function updateQuote(pool, id, input) {
    const fields = [];
    const vals = [];
    let i = 1;
    const push = (k, v) => { fields.push(`${k} = $${i++}`); vals.push(v); };
    if (input.category !== undefined)
        push("category", input.category);
    if (input.text !== undefined)
        push("text", input.text);
    if (input.author !== undefined)
        push("author", input.author);
    if (input.active !== undefined)
        push("active", input.active);
    if (fields.length === 0) {
        const { rows } = await pool.query(`SELECT * FROM signage_quotes WHERE id=$1`, [id]);
        return rows[0] || null;
    }
    vals.push(id);
    const { rows } = await pool.query(`UPDATE signage_quotes SET ${fields.join(", ")}, updated_at = now()
     WHERE id = $${i}
     RETURNING *`, vals);
    return rows[0] || null;
}
async function deleteQuote(pool, id) {
    const { rowCount } = await pool.query(`DELETE FROM signage_quotes WHERE id=$1`, [id]);
    return (rowCount ?? 0) > 0;
}
