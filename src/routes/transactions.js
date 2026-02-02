"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var express_1 = require("express");
var router = express_1.default.Router();
// fejlesztési placeholder
router.get("/", function (_req, res) { return res.json([{ id: 1, type: "income", amount: 10000 }]); });
exports.default = router;
