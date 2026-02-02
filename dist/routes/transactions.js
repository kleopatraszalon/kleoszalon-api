"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const router = express_1.default.Router();
// fejlesztési placeholder
router.get("/", (_req, res) => res.json([{ id: 1, type: "income", amount: 10000 }]));
exports.default = router;
