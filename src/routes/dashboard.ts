import { Router, Request, Response } from "express";
import pool from "../db";

const router = Router();

router.get("/", async (_req: Request, res: Response) => {
  const client = await pool.connect();
  try {
    const [{ daily_revenue }] = (
      await client.query(`
        SELECT COALESCE(SUM(amount),0) AS daily_revenue 
        FROM financial_transaction 
        WHERE DATE(created_at) = CURRENT_DATE
      `)
    ).rows;

    const [{ monthly_revenue }] = (
      await client.query(`
        SELECT COALESCE(SUM(amount),0) AS monthly_revenue 
        FROM financial_transaction 
        WHERE DATE_PART('month', created_at) = DATE_PART('month', CURRENT_DATE)
      `)
    ).rows;

    const [{ total_clients }] = (
      await client.query(`SELECT COUNT(*) AS total_clients FROM clients`)
    ).rows;

    const [{ active_appointments }] = (
      await client.query(
        `SELECT COUNT(*) AS active_appointments FROM bookings WHERE status = 'active'`
      )
    ).rows;

    const [{ low_stock_count }] = (
      await client.query(
        `SELECT COUNT(*) AS low_stock_count FROM stock WHERE quantity < 5`
      )
    ).rows;

    const chartData = (
      await client.query(`
        SELECT TO_CHAR(created_at, 'MM-DD') AS date, SUM(amount) AS revenue
        FROM financial_transaction
        WHERE created_at > NOW() - INTERVAL '7 days'
        GROUP BY date
        ORDER BY date
      `)
    ).rows;

    res.json({
      stats: {
        dailyRevenue: Number(daily_revenue),
        monthlyRevenue: Number(monthly_revenue),
        totalClients: Number(total_clients),
        activeAppointments: Number(active_appointments),
        lowStockCount: Number(low_stock_count),
      },
      chartData,
    });
  } catch (error) {
    console.error("❌ Dashboard query failed:", error);
    res.status(500).json({ error: "Dashboard lekérdezés sikertelen" });
  } finally {
    client.release();
  }
});

export default router;
