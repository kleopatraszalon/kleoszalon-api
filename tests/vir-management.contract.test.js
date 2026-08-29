const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),"utf8");

test("VIR management router is mounted behind authenticated VIR routing",()=>{
  const vir=read("src/routes/vir.ts");
  assert.match(vir,/router\.use\(requireAuth\)/);
  assert.match(vir,/router\.use\("\/management", virManagementRouter\)/);
});

test("VIR management endpoints are management-only and persist unified actions",()=>{
  const source=read("src/routes/virManagement.ts");
  for(const marker of ["router.use(requireManagement)","CREATE TABLE IF NOT EXISTS vir_action_items",'router.get("/cockpit"','router.get("/actions"','router.post("/actions"','router.patch("/actions/:id"',"assignee_name","due_at","evidence","requires_approval"])assert.ok(source.includes(marker),`missing ${marker}`);
});

test("Manager Cockpit derives operational signals from real VIR data",()=>{
  const source=read("src/routes/virManagement.ts");
  for(const marker of ["public.vir_dashboard_summary","vir_kpi_targets","work_shifts","Napi árbevételi terv elmaradás","Magas no-show arány","Magas lemondási arány"])assert.ok(source.includes(marker),`missing ${marker}`);
  assert.ok(!source.includes("demoRevenue"));
});

test("action queue has governed priority and status vocabulary",()=>{
  const source=read("src/routes/virManagement.ts");
  for(const marker of ["CRITICAL","HIGH","MEDIUM","LOW","OPEN","IN_PROGRESS","BLOCKED","WAITING_APPROVAL","DONE"])assert.ok(source.includes(marker),`missing ${marker}`);
});
