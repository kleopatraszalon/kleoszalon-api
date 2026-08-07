import type { Request, Response, NextFunction } from "express";
import { requireMenuPermission, type MenuAction } from "./menuPermission";

type Rule = { test: (method: string, path: string) => boolean; code: string; action: MenuAction };

const orderRules: Rule[] = [
  { test:(m,p)=>m==="GET" && p.startsWith("/suggestions"), code:"procurement.suggestions", action:"can_view" },
  { test:(m,p)=>m==="POST" && p==="/orders", code:"procurement.orders", action:"can_create" },
  { test:(m,p)=>m==="GET" && p.startsWith("/orders"), code:"procurement.orders", action:"can_view" },
  { test:(m,p)=>m==="PATCH" && /\/orders\/[^/]+\/status$/.test(p), code:"procurement.orders", action:"can_edit" },
  { test:(m,p)=>m==="POST" && /\/orders\/[^/]+\/receive$/.test(p), code:"procurement.orders", action:"can_edit" },
];

const workflowRules: Rule[] = [
  { test:(m,p)=>m==="GET" && p==="/settings", code:"procurement.dashboard", action:"can_view" },
  { test:(m,p)=>m==="PUT" && p==="/settings", code:"procurement.dashboard", action:"can_edit" },
  { test:(m,p)=>m==="GET" && p==="/pending", code:"procurement.approvals", action:"can_view" },
  { test:(m,p)=>m==="POST" && /\/orders\/[^/]+\/request-approval$/.test(p), code:"procurement.orders", action:"can_edit" },
  { test:(m,p)=>m==="POST" && /\/orders\/[^/]+\/(approve|reject)$/.test(p), code:"procurement.approvals", action:"can_approve" },
  { test:(m,p)=>m==="GET" && /\/orders\/[^/]+\/document\.pdf$/.test(p), code:"procurement.orders", action:"can_export" },
  { test:(m,p)=>m==="GET" && p==="/supplier-performance", code:"procurement.performance", action:"can_view" },
  { test:(m,p)=>m==="GET" && p==="/alerts", code:"procurement.deviations", action:"can_view" },
];

function enforce(rules: Rule[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const method=req.method.toUpperCase();
    const path=req.path;
    const rule=rules.find(r=>r.test(method,path));
    if(!rule)return next();
    return requireMenuPermission(rule.code,rule.action)(req as any,res,next);
  };
}

export const requirePurchaseOrderAccess = enforce(orderRules);
export const requireProcurementWorkflowAccess = enforce(workflowRules);
