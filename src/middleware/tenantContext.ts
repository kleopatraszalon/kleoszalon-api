import { NextFunction, Response } from "express";
import db from "../db";
import { AuthRequest } from "./auth";
import { ensureSaasCore } from "../saas/ensureSaasCore";

export interface TenantAuthRequest extends AuthRequest {
  tenant?: { id:string; slug:string; name:string; role:string; status:string };
}

/**
 * Resolve tenant context only from explicit ownership:
 *  - active tenant_users membership for normal/system users, or
 *  - an authenticated employee whose tenant is proven through employees.tenant_id
 *    or the employee's assigned location tenant.
 *
 * A JWT tenant_id may narrow the selection but can never create membership.
 * There is deliberately no default/Kleopatra fallback.
 */
export async function requireTenantContext(req:TenantAuthRequest,res:Response,next:NextFunction){
  try{
    await ensureSaasCore();
    const authUser=req.user;
    const tokenTenantId=authUser?.tenant_id?String(authUser.tenant_id):"";
    const userId=authUser?.id!=null?String(authUser.id):"";
    const employeeId=authUser?.employee_id!=null?String(authUser.employee_id):"";

    if(!userId){
      return res.status(403).json({ok:false,code:"TENANT_ACCESS_DENIED",error:"A felhasználóhoz nincs aktív SaaS tenant-hozzáférés rendelve."});
    }

    const membership=await db.query(
      `SELECT t.id::text AS id,t.slug,t.name,t.status,tu.tenant_role
         FROM tenant_users tu
         JOIN tenants t ON t.id=tu.tenant_id
        WHERE tu.user_id=$1
          AND tu.active=true
          AND t.status IN ('active','trial')
          AND ($2='' OR t.id::text=$2)
        ORDER BY t.id
        LIMIT 1`,
      [userId,tokenTenantId]
    );
    let tenant=membership.rows[0];

    if(!tenant&&employeeId){
      const employeeTenant=await db.query(
        `SELECT t.id::text AS id,t.slug,t.name,t.status,'member'::text AS tenant_role
           FROM employees e
           LEFT JOIN locations l ON l.id::text=e.location_id::text
           JOIN tenants t ON t.id=COALESCE(e.tenant_id,l.tenant_id)
          WHERE e.id::text=$1
            AND COALESCE(e.active,true)=true
            AND t.status IN ('active','trial')
            AND ($2='' OR t.id::text=$2)
          LIMIT 1`,
        [employeeId,tokenTenantId]
      );
      tenant=employeeTenant.rows[0];
    }

    if(!tenant){
      return res.status(403).json({ok:false,code:"TENANT_ACCESS_DENIED",error:"A felhasználóhoz nincs aktív SaaS tenant-hozzáférés rendelve."});
    }

    req.tenant={
      id:String(tenant.id),
      slug:String(tenant.slug),
      name:String(tenant.name),
      role:String(tenant.tenant_role||"member"),
      status:String(tenant.status),
    };
    if(authUser)authUser.tenant_id=req.tenant.id;
    return next();
  }catch(error){
    console.error("[SAAS] tenant context error:",error);
    return res.status(500).json({ok:false,code:"TENANT_CONTEXT_ERROR",error:"A tenant-környezet nem tölthető be."});
  }
}

export function requireTenantRole(...allowedRoles:string[]){
  const allowed=new Set(allowedRoles.map(x=>x.toLowerCase()));
  return(req:TenantAuthRequest,res:Response,next:NextFunction)=>{
    const role=String(req.tenant?.role||"").toLowerCase();
    if(!role||!allowed.has(role))return res.status(403).json({ok:false,code:"TENANT_ROLE_FORBIDDEN",error:"Nincs megfelelő tenant jogosultság."});
    return next();
  };
}
