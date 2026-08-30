import fs from 'fs';
import {describe,it,expect} from 'vitest';
const vir=fs.readFileSync('src/routes/vir.ts','utf8');
const p12=fs.readFileSync('src/routes/virP12.ts','utf8');
const p13=fs.readFileSync('src/routes/virP13.ts','utf8');
const p14=fs.readFileSync('src/routes/virP14.ts','utf8');
const p15=fs.readFileSync('src/routes/virP15.ts','utf8');
describe('VIR P12-P15 controlled autopilot layers',()=>{
 it('mounts every wave',()=>{for(const x of ['/p12','/p13','/p14','/p15'])expect(vir).toContain(`router.use("${x}"`)});
 it('P12 orchestrates journey without automatic customer mutation',()=>{for(const x of ['/journey/:clientId','/next-step/:clientId','/recovery-queue','automatic_customer_mutation:false'])expect(p12).toContain(x)});
 it('P13 protects revenue without automatic charge or discount',()=>{for(const x of ['/protection/preview','/loyalty-health/:clientId','/save-offer/preview','automatic_charge:false','automatic_discount:false'])expect(p13).toContain(x)});
 it('P14 previews workforce changes only',()=>{for(const x of ['/workforce-pressure','/capacity-gaps','/service-bottlenecks','/shift-plan/preview','automatic_roster_change:false'])expect(p14).toContain(x)});
 it('P15 keeps approval separate from execution',()=>{for(const x of ['/command-center','/action-plans/preview','/action-plans/:id/approve','execution_enabled:false','A jóváhagyás nem hajtja végre az operatív műveletet.'])expect(p15).toContain(x)});
});
