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

test("VIR intelligence is tenant-scoped and validates requested location with canonical bigint tenant id",()=>{
 const source=read("src/routes/virIntelligence.ts");
 for(const marker of ["req.user?.tenant_id","locations WHERE id=$1::uuid AND tenant_id=$2::bigint","tenantLocations(scope)"])assert.ok(source.includes(marker),`missing ${marker}`);
 assert.ok(source.includes("tenant_id=$1::bigint"),"tenant-wide location lookup must use canonical bigint tenant id");
 assert.ok(!source.includes("tenant_id=$2::uuid"),"legacy UUID tenant cast must not return");
});

test("profitability intelligence reuses canonical Wave II profit engine and tenant aggregates it",()=>{
 const source=read("src/routes/virIntelligence.ts"),wave2=read("src/services/virWave2Engine.ts");
 for(const marker of ["profitEngine","canonical_engine","material_cost","labor_cost","commission_cost","gross_profit","margin_percent","by_location","services"])assert.ok(source.includes(marker),`missing ${marker}`);
 for(const marker of ["service_material_requirements","hourly_wage","commission_percent","profit_per_minute"])assert.ok(wave2.includes(marker),`Wave II missing ${marker}`);
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