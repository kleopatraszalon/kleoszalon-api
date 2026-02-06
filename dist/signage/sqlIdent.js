"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sqlIdent = sqlIdent;
/**
 * Safely validate SQL identifiers (table/column names) to avoid injection.
 * Accepts: letters, digits, underscore. Must start with letter/underscore.
 */
function sqlIdent(x, fallback) {
    const v = (x || "").trim();
    if (!v && fallback !== undefined)
        return fallback;
    if (!v)
        throw new Error("Missing SQL identifier");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) {
        throw new Error(`Invalid SQL identifier: ${v}`);
    }
    return v;
}
