"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPool = getPool;
const pg_1 = require("pg");
let pool = null;
function getPool() {
    if (pool)
        return pool;
    const url = process.env.DATABASE_URL;
    if (!url)
        throw new Error("DATABASE_URL is not set");
    pool = new pg_1.Pool({ connectionString: url });
    return pool;
}
