const fs=require('fs');
const p='src/routes/vir.ts';
let s=fs.readFileSync(p,'utf8');
if(!s.includes('import virP10Router')) s=s.replace('import virP9Router, { virReceptionGuestActionsRouter } from "./virP9";','import virP9Router, { virReceptionGuestActionsRouter } from "./virP9";\nimport virP10Router from "./virP10";');
if(!s.includes('router.use("/p10"')) s=s.replace('router.use("/p9", virP9Router);','router.use("/p9", virP9Router);\nrouter.use("/p10", virP10Router);');
fs.writeFileSync(p,s);
fs.rmSync('scripts/apply-p10-route-patch.cjs');
fs.rmSync('.github/workflows/p10-route-one-shot.yml');
