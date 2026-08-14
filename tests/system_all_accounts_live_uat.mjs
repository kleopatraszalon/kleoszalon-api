const API_BASE = String(process.env.API_BASE || "https://kleoszalon-api-1.onrender.com").replace(/\/$/, "");
const FRONTEND_BASE = String(process.env.FRONTEND_BASE || "https://kleoszalon-frontend.onrender.com").replace(/\/$/, "");
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "Teszt1234!";
const ACCOUNTING_PASSWORD = process.env.ACCOUNTING_UAT_PASSWORD || "";

const accounts = [
  { id: "admin1", identifier: "admin1", expectedRole: "admin", kind: "admin" },
  { id: "admin2", identifier: "admin2", expectedRole: "admin", kind: "admin" },
  { id: "uzletvezeto1", identifier: "uzletvezeto1", expectedRole: "location_manager", kind: "staff" },
  { id: "recepcio1", identifier: "recepcio1", expectedRole: "receptionist", kind: "staff" },
  { id: "recepcio2", identifier: "recepcio2", expectedRole: "receptionist", kind: "staff" },
  { id: "kozmetikus1", identifier: "kozmetikus1", expectedRole: "employee", kind: "staff" },
  { id: "kozmetikus2", identifier: "kozmetikus2", expectedRole: "employee", kind: "staff" },
  { id: "ugyfel1", identifier: "ugyfel1", expectedRole: "customer", kind: "customer" },
];

const results = [];
function add(scope, name, status, detail = "") {
  const row = { scope, name, status, detail };
  results.push(row);
  console.log(`${status} | ${scope} | ${name}${detail ? ` | ${detail}` : ""}`);
}
function roles(raw) {
  if (Array.isArray(raw)) return raw.map(String).map(x => x.toLowerCase());
  const text = String(raw ?? "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String).map(x => x.toLowerCase());
  } catch {}
  return text.split(",").map(x => x.replace(/[\[\]"]/g, "").trim().toLowerCase()).filter(Boolean);
}
async function req(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      "user-agent": "Kleopatra-VIR-All-Accounts-UAT/1.0",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  return { status: response.status, ok: response.ok, body };
}
async function authReq(path, token, options = {}) {
  return req(path, { ...options, headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) } });
}
function menuCodes(tree) {
  const out = [];
  const walk = items => {
    for (const x of Array.isArray(items) ? items : []) {
      if (x?.code) out.push(String(x.code));
      walk(x?.submenus);
    }
  };
  walk(tree);
  return out;
}
function hasPrefix(codes, prefix) { return codes.some(code => code === prefix || code.startsWith(`${prefix}.`)); }

async function login(account, password = DEMO_PASSWORD) {
  const r = await req("/api/login", { method: "POST", body: JSON.stringify({ identifier: account.identifier, password }) });
  if (r.status !== 200 || !r.body?.token) {
    add(account.id, "Login", "FAIL", `HTTP ${r.status}; ${r.body?.error || "no token"}`);
    return null;
  }
  const actualRoles = roles(r.body?.role ?? r.body?.user?.role);
  const roleOk = actualRoles.includes(account.expectedRole);
  add(account.id, "Login", roleOk ? "PASS" : "FAIL", `HTTP 200; roles=${actualRoles.join(",") || "none"}; account_type=${r.body?.account_type || "?"}`);
  if (!roleOk) return null;
  if (account.kind === "staff") {
    add(account.id, "Staff location binding", r.body?.location_id ? "PASS" : "FAIL", `location_id=${r.body?.location_id || "missing"}`);
  }
  return { token: r.body.token, login: r.body, actualRoles };
}

async function commonAccountChecks(account, session) {
  const me = await authReq("/api/me", session.token);
  const meRoles = roles(me.body?.user?.role);
  add(account.id, "/api/me", me.status === 200 && meRoles.includes(account.expectedRole) ? "PASS" : "FAIL", `HTTP ${me.status}; role=${meRoles.join(",") || "?"}; location=${me.body?.user?.location_id || "none"}`);

  const menus = await authReq("/api/menus", session.token);
  const codes = menuCodes(menus.body);
  const menusOk = menus.status === 200 && (account.kind === "customer" || codes.length > 0);
  add(account.id, "Role-scoped menu", menusOk ? "PASS" : "FAIL", `HTTP ${menus.status}; visible_menu_codes=${codes.length}`);

  const caps = await authReq("/api/access-control/me/capabilities", session.token);
  add(account.id, "Capabilities", caps.status === 200 ? "PASS" : "FAIL", `HTTP ${caps.status}; admin=${caps.body?.admin === true}`);

  const adminBoundary = await authReq("/api/access-control/roles", session.token);
  const shouldAdmin = account.expectedRole === "admin";
  const boundaryOk = shouldAdmin ? adminBoundary.status === 200 : adminBoundary.status === 403;
  add(account.id, "Admin RBAC boundary", boundaryOk ? "PASS" : "FAIL", `HTTP ${adminBoundary.status}; expected=${shouldAdmin ? 200 : 403}`);

  if (codes.length) {
    if (account.expectedRole === "admin") {
      const ok = hasPrefix(codes, "appointments") && hasPrefix(codes, "finance") && hasPrefix(codes, "inventory");
      add(account.id, "Core admin modules", ok ? "PASS" : "FAIL", `appointments=${hasPrefix(codes,"appointments")}; finance=${hasPrefix(codes,"finance")}; inventory=${hasPrefix(codes,"inventory")}`);
    }
    if (account.expectedRole === "location_manager") {
      const forbiddenSettings = hasPrefix(codes, "settings.access");
      const needed = hasPrefix(codes, "appointments") && (hasPrefix(codes, "customers") || hasPrefix(codes, "crm")) && hasPrefix(codes, "inventory");
      add(account.id, "Location-manager menu scope", needed && !forbiddenSettings ? "PASS" : "FAIL", `appointments=${hasPrefix(codes,"appointments")}; customers=${hasPrefix(codes,"customers") || hasPrefix(codes,"crm")}; inventory=${hasPrefix(codes,"inventory")}; access_admin=${forbiddenSettings}`);
    }
    if (account.expectedRole === "receptionist") {
      const forbidden = hasPrefix(codes, "settings.access") || hasPrefix(codes, "marketing");
      const needed = hasPrefix(codes, "appointments") && hasPrefix(codes, "customers");
      add(account.id, "Reception menu scope", needed && !forbidden ? "PASS" : "FAIL", `appointments=${hasPrefix(codes,"appointments")}; customers=${hasPrefix(codes,"customers")}; forbidden_admin_or_marketing=${forbidden}`);
    }
    if (account.expectedRole === "employee") {
      const forbidden = hasPrefix(codes, "settings") || hasPrefix(codes, "finance") || hasPrefix(codes, "marketing") || hasPrefix(codes, "inventory");
      add(account.id, "Employee least privilege", !forbidden ? "PASS" : "FAIL", `forbidden_privileged_menu=${forbidden}`);
    }
  }

  return { me, codes, caps };
}

async function staffFunctionalChecks(account, session) {
  if (account.expectedRole === "receptionist") {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const r = await authReq(`/api/timetable/schedule?from=${today}&to=${today}`, session.token);
    add(account.id, "Own-salon timetable", r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status}`);
  }
  if (account.expectedRole === "employee") {
    const r = await authReq("/api/employee-self/dashboard", session.token);
    add(account.id, "Employee self-service", r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status}; employee=${r.body?.employee?.full_name || "?"}`);
  }
}

async function customerChecks(account, session) {
  const dash = await authReq("/api/customer-portal/dashboard", session.token);
  add(account.id, "Customer portal dashboard", dash.status === 200 ? "PASS" : "FAIL", `HTTP ${dash.status}; customer=${dash.body?.customer?.full_name || "?"}; balance=${dash.body?.account?.balance ?? "?"}`);
  const employeeSelf = await authReq("/api/employee-self/dashboard", session.token);
  add(account.id, "Customer cannot impersonate employee", employeeSelf.status === 404 || employeeSelf.status === 403 ? "PASS" : "FAIL", `HTTP ${employeeSelf.status}; expected 403/404`);
}

function classifyHealthCheck(check) {
  const key = String(check?.key || "");
  if (check?.status !== "error") return check?.status === "warning" ? "WARN" : "PASS";
  const structural = key.startsWith("table.") || key.startsWith("rbac.") || key.startsWith("menu.") || key === "database" || key === "finance.vat" || key === "ledger.balance";
  return structural ? "FAIL" : "WARN";
}

async function adminSystemChecks(session) {
  const matrix = await authReq("/api/access-control/matrix", session.token);
  add("system", "RBAC matrix endpoint", matrix.status === 200 ? "PASS" : "FAIL", `HTTP ${matrix.status}; roles=${Array.isArray(matrix.body?.roles) ? matrix.body.roles.length : "?"}; menus=${Array.isArray(matrix.body?.menus) ? matrix.body.menus.length : "?"}`);
  if (matrix.status === 200) {
    const roleKeys = new Set((matrix.body.roles || []).map(r => String(r.role_key || "").toLowerCase()));
    for (const role of ["admin","manager","location_manager","receptionist","employee","accounting"]) {
      add("system", `Configured role: ${role}`, roleKeys.has(role) ? "PASS" : "FAIL", roleKeys.has(role) ? "present" : "missing from access_roles");
    }
    add("system", "Salon-manager role record", roleKeys.has("salon_manager") ? "PASS" : "WARN", roleKeys.has("salon_manager") ? "present" : "no active access_roles row; aliases exist but no dedicated active role record");
  }

  const health = await authReq("/api/transactions/system-health", session.token);
  add("system", "System-health endpoint", health.status === 200 ? "PASS" : "FAIL", `HTTP ${health.status}; overall=${health.body?.status || "?"}; total=${health.body?.summary?.total ?? "?"}`);
  if (health.status === 200 && Array.isArray(health.body?.checks)) {
    for (const check of health.body.checks) {
      const s = classifyHealthCheck(check);
      if (s !== "PASS") add("health", check.label || check.key, s, `${check.key}: ${check.message || ""}`);
    }
  }
}

async function accountingCheck() {
  if (ACCOUNTING_PASSWORD) {
    const account = { id: "konyveles", identifier: "könyvelés", expectedRole: "accounting", kind: "accounting" };
    const session = await login(account, ACCOUNTING_PASSWORD);
    if (!session) return;
    await commonAccountChecks(account, session);
    const caps = await authReq("/api/access-control/me/capabilities", session.token);
    const finance = caps.body?.features?.finance;
    const inventory = caps.body?.features?.inventory;
    const procurement = caps.body?.features?.procurement;
    const ok = caps.status === 200 && finance?.can_use === true && inventory?.can_use === true && procurement?.can_use === true;
    add(account.id, "Accounting module access", ok ? "PASS" : "FAIL", `finance=${finance?.can_use}; inventory=${inventory?.can_use}; procurement=${procurement?.can_use}`);
  } else {
    const probe = await req("/api/login", { method: "POST", body: JSON.stringify({ identifier: "könyvelés", password: "__UAT_INTENTIONALLY_WRONG__" }) });
    add("konyveles", "Accounting login bootstrap", probe.status === 401 ? "PASS" : "FAIL", `HTTP ${probe.status}; expected 401, not 500`);
    add("konyveles", "Authenticated accounting account UAT", "BLOCKED", "ACCOUNTING_UAT_PASSWORD GitHub Actions secret is not configured for this test run.");
  }
}

async function frontendSmoke() {
  for (const path of ["/", "/login"]) {
    try {
      const r = await fetch(`${FRONTEND_BASE}${path}`, { redirect: "follow", headers: { "user-agent": "Kleopatra-VIR-All-Accounts-UAT/1.0" } });
      add("frontend", `GET ${path}`, r.status === 200 ? "PASS" : "FAIL", `HTTP ${r.status}`);
    } catch (e) { add("frontend", `GET ${path}`, "FAIL", e?.message || String(e)); }
  }
}

async function main() {
  const health = await req("/api/health");
  add("system", "Live API health", health.status === 200 && health.body?.ok === true && health.body?.db?.ok === true ? "PASS" : "FAIL", `HTTP ${health.status}; db=${health.body?.db?.ok}`);
  await frontendSmoke();

  let admin1 = null;
  for (const account of accounts) {
    const session = await login(account);
    if (!session) continue;
    await commonAccountChecks(account, session);
    if (account.kind === "staff") await staffFunctionalChecks(account, session);
    if (account.kind === "customer") await customerChecks(account, session);
    if (account.id === "admin1") admin1 = session;
  }

  await accountingCheck();
  if (admin1) await adminSystemChecks(admin1);
  else add("system", "Admin-wide system diagnostics", "BLOCKED", "admin1 login failed");

  const counts = Object.fromEntries(["PASS","WARN","FAIL","BLOCKED"].map(s => [s, results.filter(r => r.status === s).length]));
  console.log("\n=== VIR ALL-ACCOUNTS LIVE UAT SUMMARY ===");
  console.log(JSON.stringify(counts));
  console.log(`Accounts attempted: ${accounts.length + 1} (including accounting)`);
  console.log("No destructive business writes are performed by this suite; customer/self-service reads may execute idempotent bootstrap maintenance.");

  if (counts.FAIL > 0) process.exitCode = 1;
  else if (counts.BLOCKED > 0) console.log("UAT RESULT: YELLOW (no failures, but at least one account is blocked by missing test credential)");
  else console.log("UAT RESULT: GREEN");
}

main().catch(err => {
  console.error(`UAT_FATAL: ${err?.stack || err}`);
  process.exitCode = 1;
});
