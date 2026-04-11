"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get("/", auth_1.requireAuth, async (req, res) => {
    return res.json({
        ok: true,
        user: {
            id: req.user?.id ?? null,
            email: req.user?.email ?? null,
            role: req.user?.role ?? null,
            location_id: req.user?.location_id ?? null,
        },
    });
});
exports.default = router;
