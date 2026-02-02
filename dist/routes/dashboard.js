"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/routes/dashboard.ts
const express_1 = __importDefault(require("express"));
const db_1 = __importDefault(require("../db"));
const auth_1 = require("../middleware/auth");
const router = express_1.default.Router();
/**
 * GET /api/dashboard?location_id=<uuid>
 * Visszaadja: { stats: {...}, chartData: [{date, revenue}, ...] }
 */
router.get("/", auth_1.requireAuth, async (req, res) => {
    // 1) Lokáció meghatározása
    const qLoc = req.query.location_id?.trim();
    const isAdmin = (req.user?.role === "admin");
    const effectiveLocationId = isAdmin ? (qLoc && qLoc.length ? qLoc : null)
        : (req.user?.location_id ?? null);
    // 2) WHERE feltétel lokációra (ha kell)
    const whereLoc = effectiveLocationId ? "AND t.location_id = $1" : "";
    const args = [];
    if (effectiveLocationId)
        args.push(effectiveLocationId);
    try {
        // 3) Napi és havi bevétel + 7 napos chart (status='paid' tranzakciókból)
        const revSql = `
      WITH days AS (
        SELECT generate_series((CURRENT_DATE - INTERVAL '6 day')::date,
                               CURRENT_DATE::date,
                               INTERVAL '1 day')::date AS d
      ),
      day_rev AS (
        SELECT
          DATE(t.paid_at) AS dt,
          COALESCE(SUM(t.amount), 0)::numeric AS amount
        FROM transactions t
        WHERE t.status = 'paid'
          ${whereLoc}
        GROUP BY DATE(t.paid_at)
      )
      SELECT
        -- napi bevétel
        COALESCE((
          SELECT SUM(t.amount)::numeric
          FROM transactions t
          WHERE t.status='paid'
            AND DATE(t.paid_at)=CURRENT_DATE
            ${whereLoc}
        ), 0) AS daily_revenue,
        -- havi bevétel
        COALESCE((
          SELECT SUM(t.amount)::numeric
          FROM transactions t
          WHERE t.status='paid'
            AND date_trunc('month', t.paid_at)=date_trunc('month', now())
            ${whereLoc}
        ), 0) AS monthly_revenue,
        -- chartData az elmúlt 7 napra (mindig legyen 7 sor, null napokon 0)
        (
          SELECT json_agg(json_build_object('date', d.d::text, 'revenue', COALESCE(dr.amount,0)) ORDER BY d.d)
          FROM days d
          LEFT JOIN day_rev dr ON dr.dt = d.d
        ) AS chart_data
    `;
        const revRes = await db_1.default.query(revSql, args);
        const row = revRes.rows[0] || {};
        const dailyRevenue = Number(row.daily_revenue || 0);
        const monthlyRevenue = Number(row.monthly_revenue || 0);
        const chartData = Array.isArray(row.chart_data) ? row.chart_data : [];
        // 4) Összes ügyfél (ha van location_id a clients táblában, akkor arra szűrjünk; ha nincs, számoljuk globálisan)
        // Itt globális számolást adok (stabil), ha van clients.location_id oszlopod, cseréld erre:
        //   const clientsSql = `SELECT COUNT(*)::int AS c FROM clients WHERE location_id = $1`;
        let totalClients = 0;
        {
            const clientsSql = `SELECT COUNT(*)::int AS c FROM clients`;
            const cRes = await db_1.default.query(clientsSql);
            totalClients = Number(cRes.rows?.[0]?.c || 0);
        }
        // 5) Aktív mai időpontok (status in (...) és TODAY). Feltételezzük: appointments.status, start_time, location_id létezik.
        const apptArgs = [...args];
        const apptSql = `
      SELECT COUNT(*)::int AS c
      FROM appointments a
      WHERE DATE(a.start_time)=CURRENT_DATE
        AND a.status IN ('scheduled','confirmed','in_progress')
        ${effectiveLocationId ? "AND a.location_id = $1" : ""}
    `;
        const apptRes = await db_1.default.query(apptSql, apptArgs);
        const activeAppointments = Number(apptRes.rows?.[0]?.c || 0);
        // 6) Low stock – ha nincs készlet tábla, legyen 0 (ne essen szét a Home)
        const lowStockCount = 0;
        // 7) Válasz összeállítása a Home.tsx által elvárt formában
        return res.json({
            stats: {
                dailyRevenue,
                monthlyRevenue,
                totalClients,
                activeAppointments,
                lowStockCount
            },
            chartData
        });
    }
    catch (err) {
        console.error("❌ /api/dashboard hiba:", err);
        // Adjunk “üres, de szerkezetileg helyes” választ, hogy a Home ne omoljon össze.
        return res.json({
            stats: {
                dailyRevenue: 0,
                monthlyRevenue: 0,
                totalClients: 0,
                activeAppointments: 0,
                lowStockCount: 0
            },
            chartData: []
        });
    }
});
exports.default = router;
