import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";
import { getLoyaltyNotifications } from "../services/loyaltyNotificationSource";
import {
  collectOperationalAlerts,
  createEmployeeDocument,
  createSupplierExpiryBatch,
  getAlertPreferences,
  listEmployeeDocuments,
  listSupplierExpiryBatches,
  operationalAlertSummary,
  runOperationalAlertAutomation,
  subscribeStaffPush,
  unsubscribeStaffPush,
  updateAlertPreferences,
  updateEmployeeDocument,
  updateSupplierExpiryBatch,
} from "../services/operationalAlertAutomation";

const router = Router();
router.use(requireAuth);

type NotificationItem = {
  key: string;
  type: "chat" | "stock" | "no_show" | "task" | "ai" | "finance" | "workorder" | "loyalty" | "supplier_expiry" | "employee_document" | "complaint_sla";
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  route?: string;
  created_at: string;
};

function notificationUserKey(req: AuthRequest) {
  return req.user?.email ? `email:${String(req.user.email).toLowerCase()}` : `user:${String(req.user?.id ?? "unknown")}`;
}

function roles(req: AuthRequest) {
  const raw: any = req.user?.role;
  if (Array.isArray(raw)) return raw.map(String).map(x => x.toLowerCase());
  try {
    const parsed = JSON.parse(String(raw || ""));
    if (Array.isArray(parsed)) return parsed.map(String).map(x => x.toLowerCase());
  } catch {}
  return String(raw || "").replace(/[\[\]"]/g, "").split(",").map(x => x.trim().toLowerCase()).filter(Boolean);
}

function managementOnly(req: AuthRequest, res: any) {
  const allowed = new Set(["admin","administrator","superadmin","super_admin","manager","vezető","vezeto","location_manager","salon_manager","szalonvezető","szalonvezeto","üzletvezető","uzletvezeto"]);
  if (roles(req).some(role => allowed.has(role))) return true;
  res.status(403).json({ message: "Ehhez a művelethez vezetői jogosultság szükséges." });
  return false;
}

async function safeRows(sql: string, params: any[] = []) {
  try { return (await db.query(sql, params)).rows; }
  catch (err: any) {
    console.warn("notification source skipped:", String(err?.message || err));
    return [];
  }
}

router.get("/preferences", async (req: AuthRequest, res, next) => {
  try { res.json(await getAlertPreferences(req.user)); }
  catch (err) { next(err); }
});

router.put("/preferences", async (req: AuthRequest, res, next) => {
  try { res.json(await updateAlertPreferences(req.user, req.body || {})); }
  catch (err) { next(err); }
});

router.post("/push-subscriptions", async (req: AuthRequest, res, next) => {
  try { res.status(201).json(await subscribeStaffPush(req.user, req.body?.subscription || req.body)); }
  catch (err) { next(err); }
});

router.delete("/push-subscriptions", async (req: AuthRequest, res, next) => {
  try { res.json(await unsubscribeStaffPush(req.user, req.body?.endpoint || req.query?.endpoint as string | undefined)); }
  catch (err) { next(err); }
});

router.get("/automation/summary", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.json(await operationalAlertSummary(req.user?.location_id == null ? null : String(req.user.location_id)));
  } catch (err) { next(err); }
});

router.post("/automation/run", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.json({ ok: true, ...(await runOperationalAlertAutomation()) });
  } catch (err) { next(err); }
});

router.get("/automation/employee-documents", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.json(await listEmployeeDocuments(String(req.query.employee_id || "") || null));
  } catch (err) { next(err); }
});

router.post("/automation/employee-documents", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.status(201).json(await createEmployeeDocument(req.body || {}));
  } catch (err) { next(err); }
});

router.patch("/automation/employee-documents/:id", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.json(await updateEmployeeDocument(req.params.id, req.body || {}));
  } catch (err) { next(err); }
});

router.delete("/automation/employee-documents/:id", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.json(await updateEmployeeDocument(req.params.id, { active: false }));
  } catch (err) { next(err); }
});

router.get("/automation/supplier-expiry-batches", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    const locationId = String(req.query.location_id || req.user?.location_id || "") || null;
    res.json(await listSupplierExpiryBatches(locationId));
  } catch (err) { next(err); }
});

router.post("/automation/supplier-expiry-batches", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.status(201).json(await createSupplierExpiryBatch(req.body || {}));
  } catch (err) { next(err); }
});

router.patch("/automation/supplier-expiry-batches/:id", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.json(await updateSupplierExpiryBatch(req.params.id, req.body || {}));
  } catch (err) { next(err); }
});

router.delete("/automation/supplier-expiry-batches/:id", async (req: AuthRequest, res, next) => {
  try {
    if (!managementOnly(req, res)) return;
    res.json(await updateSupplierExpiryBatch(req.params.id, { active: false }));
  } catch (err) { next(err); }
});

router.get("/", async (req: AuthRequest, res, next) => {
  try {
    const key = notificationUserKey(req);
    const locationId = req.user?.location_id == null ? null : String(req.user.location_id);
    const notifications: NotificationItem[] = [];

    const [chatRows, stockRows, noShowRows, taskRows, financeRows, workorderRows, aiRows, stateRows, operationalAlerts] = await Promise.all([
      safeRows(`SELECT COUNT(*)::int AS count, MAX(m.created_at) AS last_at
                FROM staff_chat_messages m
                JOIN staff_chat_members sm ON sm.conversation_id=m.conversation_id
                WHERE sm.member_key=$1 AND m.sender_key<>$1 AND m.read_at IS NULL`, [key]),
      safeRows(`SELECT COUNT(*)::int AS low_count,
                       COUNT(*) FILTER (WHERE COALESCE(b.quantity,0)<=0)::int AS out_count
                FROM product_stock_balances b
                WHERE ($1::text IS NULL OR b.location_id::text=$1::text)
                  AND (COALESCE(b.quantity,0)<=COALESCE(b.min_quantity,0) OR COALESCE(b.quantity,0)<=0)`, [locationId]),
      safeRows(`SELECT COUNT(*)::int AS count, MAX(COALESCE(completed_at,created_at)) AS last_at
                FROM work_orders
                WHERE status='no_show'
                  AND COALESCE(completed_at,created_at)>=now()-interval '24 hours'
                  AND ($1::text IS NULL OR location_id::text=$1::text)`, [locationId]),
      safeRows(`SELECT id,title,status,due_at,priority
                FROM vir_module_records
                WHERE module_key='tasks' AND is_active
                  AND status NOT IN ('completed','approved','cancelled')
                  AND due_at IS NOT NULL AND due_at<now()
                  AND ($1::text IS NULL OR location_id IS NULL OR location_id=$1::text)
                ORDER BY due_at ASC LIMIT 20`, [locationId]),
      safeRows(`SELECT COUNT(*)::int AS count, MAX(updated_at) AS last_at
                FROM work_orders
                WHERE payment_status IN ('unpaid','partial')
                  AND status='completed'
                  AND COALESCE(completed_at,updated_at)<now()-interval '2 hours'
                  AND ($1::text IS NULL OR location_id::text=$1::text)`, [locationId]),
      safeRows(`SELECT COUNT(*)::int AS count, MAX(updated_at) AS last_at
                FROM work_orders
                WHERE financial_closed_at IS NOT NULL
                  AND (amount_paid<amount_due OR amount_due<0 OR gross_total<0)
                  AND ($1::text IS NULL OR location_id::text=$1::text)`, [locationId]),
      safeRows(`SELECT COUNT(*)::int AS request_count,
                       COALESCE(SUM(estimated_cost_usd),0)::numeric AS cost
                FROM ai_usage_log
                WHERE created_at>=date_trunc('month',now())`),
      safeRows(`SELECT notification_key,read_at,dismissed_at FROM notification_read_state WHERE user_key=$1`, [key]),
      collectOperationalAlerts(locationId).catch((err: any) => { console.warn("operational alerts skipped:", err?.message || err); return []; }),
    ]);

    const now = new Date().toISOString();
    const chatCount = Number(chatRows[0]?.count || 0);
    if (chatCount > 0) notifications.push({ key:"chat:unread", type:"chat", severity:"info", title:`${chatCount} új chatüzenet`, detail:"Olvasatlan belső üzeneteid vannak.", route:"/extra/chat", created_at:chatRows[0]?.last_at || now });

    const low = Number(stockRows[0]?.low_count || 0), out = Number(stockRows[0]?.out_count || 0);
    if (out > 0) notifications.push({ key:"stock:out", type:"stock", severity:"critical", title:`${out} kifogyott termék`, detail:"Azonnali készletellenőrzés szükséges.", route:"/warehouse", created_at:now });
    else if (low > 0) notifications.push({ key:"stock:low", type:"stock", severity:"warning", title:`${low} alacsony készletű termék`, detail:"A minimum készletszint elérése miatt utánrendelés javasolt.", route:"/warehouse", created_at:now });

    const noShow = Number(noShowRows[0]?.count || 0);
    if (noShow > 0) notifications.push({ key:"noshow:24h", type:"no_show", severity:noShow >= 5 ? "warning" : "info", title:`${noShow} no-show az elmúlt 24 órában`, detail:"Érdemes ellenőrizni az érintett foglalásokat és vendégeket.", route:"/appointments/calendar", created_at:noShowRows[0]?.last_at || now });

    for (const row of taskRows) notifications.push({ key:`task:${row.id}`, type:"task", severity:String(row.priority).toLowerCase()==="high" ? "critical" : "warning", title:`Lejárt feladat: ${row.title}`, detail:`Határidő: ${new Date(row.due_at).toLocaleString("hu-HU")}`, route:"/extra/tasks", created_at:row.due_at || now });

    const finance = Number(financeRows[0]?.count || 0);
    if (finance > 0) notifications.push({ key:"finance:pending", type:"finance", severity:"warning", title:`${finance} pénzügyileg rendezetlen munkalap`, detail:"Befejezett, de még nem teljesen rendezett munkalapok vannak.", route:"/finance", created_at:financeRows[0]?.last_at || now });

    const abnormal = Number(workorderRows[0]?.count || 0);
    if (abnormal > 0) notifications.push({ key:"workorder:abnormal", type:"workorder", severity:"critical", title:`${abnormal} rendellenes munkalap`, detail:"Pénzügyi ellentmondás található lezárt munkalapokon.", route:"/workorders", created_at:workorderRows[0]?.last_at || now });

    const budget = Number(process.env.AI_MONTHLY_BUDGET_USD || 10);
    const aiCost = Number(aiRows[0]?.cost || 0);
    if (budget > 0 && aiCost / budget >= 0.8) notifications.push({ key:"ai:budget", type:"ai", severity:aiCost >= budget ? "critical" : "warning", title:aiCost >= budget ? "Az AI havi kerete elfogyott" : "Az AI havi keret 80% fölött jár", detail:`Becsült felhasználás: $${aiCost.toFixed(2)} / $${budget.toFixed(2)}`, route:"/dashboard/notifications", created_at:now });

    for (const alert of operationalAlerts) notifications.push(alert as NotificationItem);

    try { notifications.push(...await getLoyaltyNotifications()); }
    catch (err: any) { console.warn("loyalty notifications skipped:", String(err?.message || err)); }

    const states = new Map(stateRows.map((x:any)=>[String(x.notification_key),x]));
    const items = notifications
      .filter(n => !states.get(n.key)?.dismissed_at)
      .map(n => ({ ...n, read: Boolean(states.get(n.key)?.read_at) }))
      .sort((a,b) => {
        const sev = { critical: 0, warning: 1, info: 2 } as const;
        const d = sev[a.severity] - sev[b.severity];
        return d || (+new Date(b.created_at)-+new Date(a.created_at));
      });

    res.json({ items, unread_count: items.filter(x=>!x.read).length, generated_at: now });
  } catch (err) { next(err); }
});

router.post("/:notificationKey/read", async (req: AuthRequest, res, next) => {
  try {
    await db.query(`INSERT INTO notification_read_state(user_key,notification_key,read_at,updated_at)
                    VALUES($1,$2,now(),now())
                    ON CONFLICT(user_key,notification_key) DO UPDATE SET read_at=now(),dismissed_at=NULL,updated_at=now()`, [notificationUserKey(req), req.params.notificationKey]);
    res.json({ ok:true });
  } catch (err) { next(err); }
});

router.post("/:notificationKey/dismiss", async (req: AuthRequest, res, next) => {
  try {
    await db.query(`INSERT INTO notification_read_state(user_key,notification_key,dismissed_at,updated_at)
                    VALUES($1,$2,now(),now())
                    ON CONFLICT(user_key,notification_key) DO UPDATE SET dismissed_at=now(),updated_at=now()`, [notificationUserKey(req), req.params.notificationKey]);
    res.json({ ok:true });
  } catch (err) { next(err); }
});

router.post("/read-all", async (_req: AuthRequest, res) => {
  res.json({ ok:true, note:"A látható értesítéseket a kliens egyenként jelöli olvasottnak." });
});

export default router;
