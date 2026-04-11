import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";

const router = Router();

function isAdmin(req: AuthRequest) {
  return (req.user?.role || "").toLowerCase() === "admin";
}

function scopedLocation(req: AuthRequest): string | null {
  if (isAdmin(req)) return null;
  return req.user?.location_id ? String(req.user.location_id) : null;
}

router.get("/staff/:staffId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { staffId } = req.params;
    const locationId = scopedLocation(req);

    const staffSql = `
      SELECT
        e.id AS employee_id,
        e.full_name,
        e.short_name,
        COALESCE(sp.appointments_count, 0) AS appointments_count,
        COALESCE(sp.completed_count, 0) AS completed_count,
        COALESCE(sp.revenue_total, 0) AS revenue_total,
        COALESCE(sp.revenue_per_hour, 0) AS revenue_per_hour
      FROM employees e
      LEFT JOIN vw_vir_staff_performance sp ON sp.employee_id = e.id
      WHERE e.id = $1
        AND ($2::uuid IS NULL OR e.location_id = $2::uuid)
      LIMIT 1
    `;
    const servicesSql = `
      SELECT
        s.id AS service_id,
        s.name AS service_name,
        COUNT(*)::int AS bookings_count,
        COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total
      FROM appointment_services aps
      JOIN appointments a ON a.id = aps.appointment_id
      JOIN services s ON s.id = aps.service_id
      WHERE a.employee_id = $1
        AND ($2::uuid IS NULL OR a.location_id = $2::uuid)
      GROUP BY s.id, s.name
      ORDER BY revenue_total DESC, bookings_count DESC
    `;
    const [staff, services] = await Promise.all([
      pool.query(staffSql, [staffId, locationId]),
      pool.query(servicesSql, [staffId, locationId]),
    ]);

    return res.json({ ok: true, data: { staff: staff.rows[0] || null, services: services.rows, recent_appointments: [] } });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "staff_drilldown_failed" });
  }
});

router.get("/service/:serviceId", requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { serviceId } = req.params;
    const locationId = scopedLocation(req);

    const serviceSql = `
      SELECT
        v.service_id,
        v.service_name,
        v.bookings_count,
        v.revenue_total,
        v.avg_price
      FROM vw_vir_service_performance v
      WHERE v.service_id = $1
        AND ($2::uuid IS NULL OR v.location_id = $2::uuid)
      LIMIT 1
    `;
    const staffSql = `
      SELECT
        e.id AS employee_id,
        COALESCE(e.short_name, e.full_name) AS staff_name,
        COUNT(*)::int AS bookings_count,
        COALESCE(SUM(COALESCE(aps.price,0)),0)::numeric(14,2) AS revenue_total
      FROM appointment_services aps
      JOIN appointments a ON a.id = aps.appointment_id
      JOIN employees e ON e.id = a.employee_id
      WHERE aps.service_id = $1
        AND ($2::uuid IS NULL OR a.location_id = $2::uuid)
      GROUP BY e.id, COALESCE(e.short_name, e.full_name)
      ORDER BY revenue_total DESC, bookings_count DESC
    `;
    const [service, staff] = await Promise.all([
      pool.query(serviceSql, [serviceId, locationId]),
      pool.query(staffSql, [serviceId, locationId]),
    ]);

    return res.json({ ok: true, data: { service: service.rows[0] || null, staff: staff.rows, recent_appointments: [] } });
  } catch (error: any) {
    return res.status(500).json({ ok: false, error: error?.message || "service_drilldown_failed" });
  }
});

export default router;
