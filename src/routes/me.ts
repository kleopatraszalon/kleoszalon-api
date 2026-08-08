import { Router, Response } from "express";
import pool from "../db";
import { AuthRequest, requireAuth } from "../middleware/auth";

const router = Router();

router.get("/", requireAuth, async (req: AuthRequest, res: Response) => {
  const id=String(req.user?.id??"").trim();
  const email=String(req.user?.email??"").trim();
  let employee:any=null;
  try{
    const {rows}=await pool.query(
      `SELECT e.id,e.full_name,e.email,e.login_name,e.location_id,l.name AS location_name,e.position_id,p.name AS position_name
         FROM employees e
         LEFT JOIN locations l ON l.id=e.location_id
         LEFT JOIN hr_positions p ON p.id=e.position_id
        WHERE e.id::text=$1 OR ($2<>'' AND (lower(COALESCE(e.email,''))=lower($2) OR lower(COALESCE(e.login_name,''))=lower($2)))
        ORDER BY CASE WHEN e.id::text=$1 THEN 0 ELSE 1 END LIMIT 1`,
      [id,email]
    );
    employee=rows[0]??null;
  }catch(error){console.warn("[/api/me] employee profile lookup failed",error);}

  return res.json({
    ok: true,
    user: {
      id: req.user?.id ?? null,
      email: employee?.email ?? req.user?.email ?? null,
      login_name: employee?.login_name ?? null,
      full_name: employee?.full_name ?? null,
      role: req.user?.role ?? null,
      location_id: employee?.location_id ?? req.user?.location_id ?? null,
      location_name: employee?.location_name ?? null,
      position_id: employee?.position_id ?? null,
      position_name: employee?.position_name ?? null,
      employee_id: employee?.id ?? null,
    },
  });
});

export default router;
