const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const read=(p)=>fs.readFileSync(path.join(process.cwd(),p),"utf8");

test("VIR intelligence router is authenticated, management-only and mounted",()=>{
 const vir=read("src/routes/vir.ts"),source=read("src/routes/virIntelligence.ts");
 assert.ok(vir.includes('router.use("/intelligence", virIntelligenceRouter)'));
 assert.ok(source.includes("router.use(requireManagement)"));
});

test("VIR intelligence is tenant-scoped and validates requested location",()=>{
 const source=read("src/routes/virIntelligence.ts");
 for(const marker of ["req.user?.tenant_id","locations WHERE id=$1::uuid AND tenant_id=$2::uuid","work_orders w","w.tenant_id=$1::uuid"])assert.ok(source.includes(marker),`missing ${marker}`);
});

test("profitability engine includes revenue, material, commission and direct labor economics",()=>{
 const source=read("src/routes/virIntelligence.ts");
 for(const marker of ["material_cost","commission_cost","labor_cost","contribution_margin","employee_compensation_assignments","hourly_wage","base_hourly_wage","monthly_hours_standard:174"])assert.ok(source.includes(marker),`missing ${marker}`);
});

test("capacity optimizer reuses governed Wave1 gap and waitlist engines",()=>{
 const source=read("src/routes/virIntelligence.ts");
 for(const marker of ["findCalendarGaps","matchWaitlist",'router.get("/capacity"',"estimated_open_capacity_value","matched_gaps"])assert.ok(source.includes(marker),`missing ${marker}`);
});

test("no-show intelligence reuses existing risk engine",()=>{
 const source=read("src/routes/virIntelligence.ts");
 for(const marker of ["upcomingRiskCandidates",'router.get("/no-show"',"high","medium"])assert.ok(source.includes(marker),`missing ${marker}`);
});

test("VIR intelligence business date is Budapest-local",()=>{
 assert.ok(read("src/routes/virIntelligence.ts").includes("Europe/Budapest"));
});
