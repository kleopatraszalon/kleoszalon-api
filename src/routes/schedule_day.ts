// src/routes/schedule_day.ts
import express from "express";
import pool from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = express.Router();

/**
 * GET /api/schedule/day?date=2025-11-11
 *
 * Napi beosztás:
 *  - admin: az ÖSSZES location aktív dolgozója
 *  - nem admin: csak a saját location_id dolgozói
 *
 * Válasz:
 * {
 *   date: "2025-11-11",
 *   locations: [
 *     {
 *       id: "location_uuid_vagy_null",
 *       name: "Telephely neve",
 *       employees: [
 *         {
 *           id: "employee_uuid",
 *           full_name: "Dolgozó Név",
 *           location_id: "...",
 *           location_name: "...",
 *           appointments: [
 *             {
 *               id: "...",
 *               title: "...",
 *               start: "2025-11-11T08:00:00.000Z",
 *               end:   "2025-11-11T08:30:00.000Z",
 *               status: "...",
 *               price: 12345,
 *               notes: "...",
 *               client_name: "...",
 *               service_name: "...",
 *               location_id: "...",
 *               location_name: "..."
 *             }
 *           ]
 *         }
 *       ]
 *     }
 *   ]
 * }
 */
router.get("/", requireAuth, async (req: AuthRequest, res) => {
  try {
    const rawDate =
      (req.query.date as string) || new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"

    // Dátum formátum ellenőrzés
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      return res
        .status(400)
        .json({ error: "Érvénytelen dátum formátum (YYYY-MM-DD kell)" });
    }

    const user = req.user!;
    const isAdmin = user.role === "admin";
    const userLocationId = user.location_id || null;

    // Nem adminnál elvárjuk, hogy legyen location_id
    if (!isAdmin && !userLocationId) {
      return res
        .status(400)
        .json({ error: "A felhasználóhoz nincs location_id rendelve" });
    }

    // 1) Aktív dolgozók lekérése
    let employeesSql = `
      SELECT 
        e.id,
        e.full_name,
        e.location_id,
        l.name AS location_name
      FROM employees e
      LEFT JOIN locations l ON l.id = e.location_id
      WHERE e.active = true
    `;
    const empParams: any[] = [];

    if (!isAdmin && userLocationId) {
      empParams.push(userLocationId);
      employeesSql += ` AND e.location_id = $${empParams.length}`;
    }

    employeesSql += ` ORDER BY l.name ASC, e.full_name ASC`;

    const employeesResult = await pool.query(employeesSql, empParams);
    const employees = employeesResult.rows;

    if (employees.length === 0) {
      return res.json({
        date: rawDate,
        locations: [],
      });
    }

    const employeeIds = employees.map((e: any) => e.id);

    // 2) Az adott napra eső időpontok lekérése az összes érintett dolgozóra
    //    -> appointments tábla, ahogy az employee_calendar route-ban is használjuk
    const appointmentsSql = `
      SELECT
        a.id,
        a.employee_id,
        a.location_id,
        a.title,
        a.start_time,
        a.end_time,
        a.status,
        a.price,
        a.notes,
        l.name AS location_name,
        c.full_name AS client_name,
        s.name AS service_name
      FROM appointments a
      LEFT JOIN locations l ON l.id = a.location_id
      LEFT JOIN clients   c ON c.id = a.client_id
      LEFT JOIN services  s ON s.id = a.service_id
      WHERE a.employee_id = ANY($1::uuid[])
        AND a.start_time >= $2::date
        AND a.start_time < ($2::date + interval '1 day')
      ORDER BY a.start_time ASC
    `;

    const appointmentsResult = await pool.query(appointmentsSql, [
      employeeIds,
      rawDate, // ::date
    ]);

    const appointments = appointmentsResult.rows;

    // 3) Összekapcsolás dolgozókkal, lokációnként csoportosítva

    type AppointmentDto = {
      id: string;
      title: string;
      start: string;
      end: string;
      status: string | null;
      price: number | null;
      notes: string | null;
      location_id: string | null;
      location_name: string | null;
      client_name: string | null;
      service_name: string | null;
    };

    type EmployeeSchedule = {
      id: string;
      full_name: string;
      location_id: string | null;
      location_name: string | null;
      appointments: AppointmentDto[];
    };

    const employeesById = new Map<string, EmployeeSchedule>();

    employees.forEach((e: any) => {
      employeesById.set(String(e.id), {
        id: String(e.id),
        full_name: e.full_name,
        location_id: e.location_id ? String(e.location_id) : null,
        location_name: e.location_name || null,
        appointments: [],
      });
    });

    appointments.forEach((a: any) => {
      const key = String(a.employee_id);
      const emp = employeesById.get(key);
      if (!emp) return;

      emp.appointments.push({
        id: String(a.id),
        title:
          a.title ||
          `${a.service_name || "Szolgáltatás"} - ${
            a.client_name || "Vendég"
          }`,
        start: a.start_time,
        end: a.end_time,
        status: a.status ?? null,
        price: a.price ?? null,
        notes: a.notes ?? null,
        location_id: a.location_id ? String(a.location_id) : null,
        location_name: a.location_name || emp.location_name,
        client_name: a.client_name || null,
        service_name: a.service_name || null,
      });
    });

    type LocationSchedule = {
      id: string | null;
      name: string;
      employees: EmployeeSchedule[];
    };

    const locationsMap = new Map<string, LocationSchedule>();

    employeesById.forEach((emp) => {
      const locId = emp.location_id || "null";
      const locName = emp.location_name || "Nincs hozzárendelt telephely";

      if (!locationsMap.has(locId)) {
        locationsMap.set(locId, {
          id: emp.location_id,
          name: locName,
          employees: [],
        });
      }
      locationsMap.get(locId)!.employees.push(emp);
    });

    const locations = Array.from(locationsMap.values()).map((loc) => ({
      ...loc,
      employees: loc.employees.sort((a, b) =>
        a.full_name.localeCompare(b.full_name, "hu")
      ),
    }));

    return res.json({
      date: rawDate,
      locations,
    });
  } catch (err) {
    console.error("❌ GET /api/schedule/day hiba:", err);
    return res
      .status(500)
      .json({ error: "Szerver hiba a napi beosztás lekérésekor" });
  }
});

export default router;
