// src/routes/workorders.ts
import { Router } from "express";
import pool from "../db";               // ahogy nálad van
import fs from "fs";
import path from "path";

const router = Router();

const workordersSql = fs.readFileSync(
  path.join(__dirname, "..", "sql", "workorders_list.sql"),
  "utf8"
);

router.get("/", async (req, res, next) => {
  try {
    const {
      locationId,
      status,
      from,
      to,
      page = "1",
      pageSize = "20",
    } = req.query as Record<string, string | undefined>;

    const pageNum = Number(page) || 1;
    const limitNum = Number(pageSize) || 20;
    const offsetNum = (pageNum - 1) * limitNum;

    // 1) locationId: UUID vagy NULL
    const pLocationId =
      locationId && locationId !== "all" && locationId.trim() !== ""
        ? locationId
        : null;

    // 2) status: TEXT vagy NULL
    const pStatus =
      status && status !== "all" && status.trim() !== "" ? status : null;

    // 3–4) dátumok: timestamp vagy NULL
    const pFrom = from && from.trim() !== "" ? new Date(from) : null;
    const pTo = to && to.trim() !== "" ? new Date(to) : null;

    // 5–6) limit & offset: számok
    const pLimit = limitNum;
    const pOffset = offsetNum;

    const params = [pLocationId, pStatus, pFrom, pTo, pLimit, pOffset];

    // DEBUG-hez:
    console.log("workorders params:", params);

    const { rows } = await pool.query(workordersSql, params);
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
