"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getServicesFromDb = getServicesFromDb;
exports.upsertServiceOverride = upsertServiceOverride;
const env_1 = require("./env");
const sqlIdent_1 = require("./sqlIdent");
/**
 * DB-based services fetch using configurable mapping.
 * Joins signage overrides by service_id::text.
 */
async function getServicesFromDb(pool, onlyEnabled) {
    const t = (0, sqlIdent_1.sqlIdent)(env_1.env.servicesTable, "services");
    const idCol = (0, sqlIdent_1.sqlIdent)(env_1.env.servicesIdCol, "id");
    const nameCol = (0, sqlIdent_1.sqlIdent)(env_1.env.servicesNameCol, "name_hu");
    const categoryCol = env_1.env.servicesCategoryCol ? (0, sqlIdent_1.sqlIdent)(env_1.env.servicesCategoryCol) : null;
    const priceCol = env_1.env.servicesPriceCol ? (0, sqlIdent_1.sqlIdent)(env_1.env.servicesPriceCol) : null;
    const durationCol = env_1.env.servicesDurationCol ? (0, sqlIdent_1.sqlIdent)(env_1.env.servicesDurationCol) : null;
    const activeCol = env_1.env.servicesActiveCol ? (0, sqlIdent_1.sqlIdent)(env_1.env.servicesActiveCol) : null;
    const selectParts = [];
    selectParts.push(`s.${idCol}::text AS id`);
    selectParts.push(`s.${nameCol}::text AS name`);
    if (categoryCol)
        selectParts.push(`COALESCE(s.${categoryCol}::text,'') AS category`);
    else
        selectParts.push(`''::text AS category`);
    if (priceCol)
        selectParts.push(`COALESCE(o.price_text_override, (s.${priceCol})::text) AS price_text`);
    else
        selectParts.push(`COALESCE(o.price_text_override,'') AS price_text`);
    if (durationCol)
        selectParts.push(`(s.${durationCol})::int AS duration_min`);
    else
        selectParts.push(`NULL::int AS duration_min`);
    selectParts.push(`COALESCE(o.enabled, true) AS enabled`);
    selectParts.push(`COALESCE(o.priority, 0) AS priority`);
    const whereParts = [];
    if (onlyEnabled)
        whereParts.push(`COALESCE(o.enabled, true) = true`);
    if (activeCol)
        whereParts.push(`COALESCE(s.${activeCol}, true) = true`);
    const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
    const q = `
    SELECT
      ${selectParts.join(",\n      ")}
    FROM ${t} s
    LEFT JOIN signage_service_overrides o ON o.service_id = s.${idCol}::text
    ${whereSql}
    ORDER BY COALESCE(o.priority, 0) DESC, s.${nameCol} ASC
    LIMIT 500
  `;
    const { rows } = await pool.query(q);
    const services = rows.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category || "",
        price_text: r.price_text || "",
        durationMin: r.duration_min === null || r.duration_min === undefined ? null : Number(r.duration_min),
        enabled: Boolean(r.enabled),
        priority: Number(r.priority || 0),
    }));
    return {
        source: `db:${t}`,
        fetchedAt: new Date().toISOString(),
        services,
    };
}
async function upsertServiceOverride(pool, input) {
    const { rows } = await pool.query(`INSERT INTO signage_service_overrides (service_id, enabled, price_text_override, priority, updated_at)
     VALUES ($1, COALESCE($2,true), $3, COALESCE($4,0), now())
     ON CONFLICT (service_id) DO UPDATE SET
        enabled = COALESCE(EXCLUDED.enabled, signage_service_overrides.enabled),
        price_text_override = EXCLUDED.price_text_override,
        priority = COALESCE(EXCLUDED.priority, signage_service_overrides.priority),
        updated_at = now()
     RETURNING *`, [
        String(input.service_id),
        input.enabled ?? true,
        input.price_text_override ?? null,
        input.priority ?? 0,
    ]);
    return rows[0];
}
