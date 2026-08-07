import { Router } from "express";
import db from "../db";
import { requireAuth, AuthRequest } from "../middleware/auth";

const router = Router();
router.use(requireAuth);

type CheckStatus = "ok" | "warning" | "error";
type Check = {
  key: string;
  group: string;
  label: string;
  status: CheckStatus;
  detail: string;
  count?: number;
};

async function tableExists(name: string) {
  const { rows } = await db.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
  return Boolean(rows[0]?.ok);
}

async function scalar(sql: string, params: any[] = []) {
  const { rows } = await db.query(sql, params);
  const row = rows[0] || {};
  const value = Object.values(row)[0];
  return Number(value || 0);
}

router.get("/summary", async (req: AuthRequest, res, next) => {
  const started = Date.now();
  try {
    const checks: Check[] = [];

    try {
      await db.query("SELECT 1");
      checks.push({ key: "database", group: "Alaprendszer", label: "PostgreSQL kapcsolat", status: "ok", detail: "Az adatbázis elérhető." });
    } catch (e: any) {
      checks.push({ key: "database", group: "Alaprendszer", label: "PostgreSQL kapcsolat", status: "error", detail: String(e?.message || "Adatbázis-kapcsolati hiba") });
      return res.json({ status: "error", checked_at: new Date().toISOString(), duration_ms: Date.now() - started, checks });
    }

    const requiredTables = [
      ["menus", "Menürendszer"],
      ["role_menu_permissions", "Menüjogosultságok"],
      ["locations", "Telephelyek"],
      ["employees", "Munkatársak"],
      ["services", "Szolgáltatások"],
      ["appointments", "Időpontok"],
      ["work_orders", "Munkalapok"],
      ["financial_accounts", "Pénzügyi számlák"],
      ["finance_invoices", "Számlák"],
      ["accounting_journal_entries", "Főkönyvi napló"],
      ["payroll_runs", "Bérszámfejtési futások"],
      ["payroll_items", "Bérszámfejtési tételek"],
      ["booking_communication_queue", "Foglalási kommunikáció"],
      ["audit_log", "Auditnapló"],
    ] as const;

    const exists = new Map<string, boolean>();
    for (const [table, label] of requiredTables) {
      const ok = await tableExists(table);
      exists.set(table, ok);
      checks.push({
        key: `table.${table}`,
        group: "Adatbázis-séma",
        label,
        status: ok ? "ok" : "error",
        detail: ok ? `${table} tábla elérhető.` : `${table} tábla hiányzik; a hozzá tartozó migrációt futtatni kell.`,
      });
    }

    if (exists.get("menus")) {
      const count = await scalar(`SELECT COUNT(*) FROM menus WHERE COALESCE(is_active,true)=true`);
      checks.push({ key: "menu.active", group: "Menü és jogosultság", label: "Aktív menüpontok", status: count > 0 ? "ok" : "error", count, detail: count > 0 ? `${count} aktív menüpont található.` : "Nincs aktív menüpont az adatbázisban." });
    }
    if (exists.get("role_menu_permissions")) {
      const count = await scalar(`SELECT COUNT(*) FROM role_menu_permissions WHERE can_view=true`);
      checks.push({ key: "menu.permissions", group: "Menü és jogosultság", label: "Látható menüjogosultságok", status: count > 0 ? "ok" : "warning", count, detail: count > 0 ? `${count} engedélyezett menü-hozzárendelés.` : "Nincs can_view=true menüjogosultság." });
    }

    for (const [table, label] of [["locations","Telephely"],["employees","Munkatárs"],["services","Szolgáltatás"],["appointments","Időpont"],["work_orders","Munkalap"]] as const) {
      if (!exists.get(table)) continue;
      const count = await scalar(`SELECT COUNT(*) FROM ${table}`);
      checks.push({ key: `data.${table}`, group: "Alapadatok", label: `${label} adatok`, status: count > 0 ? "ok" : "warning", count, detail: count > 0 ? `${count} rekord található.` : `A ${label.toLowerCase()} tábla üres.` });
    }

    if (exists.get("finance_invoices")) {
      const overdue = await scalar(`SELECT COUNT(*) FROM finance_invoices WHERE status IN ('approved','overdue') AND due_date < CURRENT_DATE`);
      const missingNo = await scalar(`SELECT COUNT(*) FROM finance_invoices WHERE status <> 'cancelled' AND invoice_no IS NULL`);
      const unposted = await scalar(`SELECT COUNT(*) FROM finance_invoices WHERE status IN ('approved','paid','overdue') AND journal_entry_id IS NULL`);
      checks.push({ key: "finance.overdue", group: "Pénzügy", label: "Lejárt számlák", status: overdue ? "warning" : "ok", count: overdue, detail: overdue ? `${overdue} lejárt, nyitott számla.` : "Nincs lejárt nyitott számla." });
      checks.push({ key: "finance.invoice_no", group: "Pénzügy", label: "Hiányzó számlaszám", status: missingNo ? "warning" : "ok", count: missingNo, detail: missingNo ? `${missingNo} aktív számlán nincs számlaszám.` : "Minden aktív számlán van számlaszám." });
      checks.push({ key: "finance.ledger", group: "Pénzügy", label: "Nem könyvelt számlák", status: unposted ? "warning" : "ok", count: unposted, detail: unposted ? `${unposted} jóváhagyott/kifizetett számla nincs főkönyvben.` : "A releváns számlák főkönyvbe kerültek." });
    }

    if (exists.get("accounting_journal_entries")) {
      const unbalanced = await scalar(`SELECT COUNT(*) FROM (SELECT je.id FROM accounting_journal_entries je JOIN accounting_journal_lines jl ON jl.journal_entry_id=je.id GROUP BY je.id HAVING ABS(COALESCE(SUM(jl.debit),0)-COALESCE(SUM(jl.credit),0)) > 0.01) x`).catch(() => 0);
      checks.push({ key: "accounting.balance", group: "Könyvelés", label: "Főkönyvi egyensúly", status: unbalanced ? "error" : "ok", count: unbalanced, detail: unbalanced ? `${unbalanced} kiegyensúlyozatlan naplótétel található.` : "A főkönyvi tételek Tartozik/Követel egyensúlya rendben." });
    }

    if (exists.get("payroll_runs")) {
      const draft = await scalar(`SELECT COUNT(*) FROM payroll_runs WHERE status IN ('draft','calculated')`);
      checks.push({ key: "payroll.open", group: "Bérszámfejtés", label: "Nyitott számfejtések", status: draft ? "warning" : "ok", count: draft, detail: draft ? `${draft} számfejtési futás még nincs jóváhagyva.` : "Nincs függő számfejtési futás." });
    }

    if (exists.get("booking_communication_queue")) {
      const failed = await scalar(`SELECT COUNT(*) FROM booking_communication_queue WHERE status='failed'`);
      checks.push({ key: "booking.communication", group: "Foglalás", label: "Sikertelen vendégértesítések", status: failed ? "warning" : "ok", count: failed, detail: failed ? `${failed} sikertelen kommunikációs tétel található.` : "Nincs sikertelen foglalási értesítés." });
    }

    const errors = checks.filter(c => c.status === "error").length;
    const warnings = checks.filter(c => c.status === "warning").length;
    const overall: CheckStatus = errors ? "error" : warnings ? "warning" : "ok";
    res.json({
      status: overall,
      checked_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      summary: { total: checks.length, ok: checks.filter(c => c.status === "ok").length, warnings, errors },
      actor: req.user?.email || req.user?.id || null,
      checks,
    });
  } catch (err) { next(err); }
});

export default router;
