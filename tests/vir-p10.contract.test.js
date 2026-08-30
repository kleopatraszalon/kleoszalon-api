const fs=require('fs');const p=fs.readFileSync('src/routes/virP10.ts','utf8');const v=fs.readFileSync('src/routes/vir.ts','utf8');
describe('VIR P10 Revenue Autopilot contract',()=>{
 it('is management protected',()=>expect(p).toContain('router.use(requireManagement)'));
 it('exposes all P10 endpoints',()=>['/dynamic-offers','/empty-slot-autopilot','/revenue-guard','/next-best-offers','/promotion-simulator'].forEach(x=>expect(p).toContain(x)));
 it('keeps human approval boundaries',()=>{expect(p).toContain('automatic_discount:false');expect(p).toContain('automatic_booking:false');expect(p).toContain('automatic_campaign:false')});
 it('uses paid ledger economics',()=>{expect(p).toContain('work_order_payments');expect(p).toContain('paid_revenue')});
 it('is mounted under p10',()=>expect(v).toContain('router.use("/p10", virP10Router)'));
});
