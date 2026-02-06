"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mountSignage = mountSignage;
const db_1 = require("./db");
const publicRouter_1 = require("./publicRouter");
const adminRouter_1 = require("./adminRouter");
function mountSignage(app) {
    const pool = (0, db_1.getPool)();
    app.use("/api/signage", (0, publicRouter_1.createSignagePublicRouter)(pool));
    app.use("/api/admin/signage", (0, adminRouter_1.createSignageAdminRouter)(pool));
}
