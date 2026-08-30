const fs=require('fs');
function patch(path,fn){const before=fs.readFileSync(path,'utf8');const after=fn(before);if(after===before)throw new Error(`No patch applied: ${path}`);fs.writeFileSync(path,after)}
patch('src/routes/vir.ts',s=>s.replace('import virP8Router from "./virP8";','import virP8Router from "./virP8";\nimport virP9Router, { virReceptionGuestActionsRouter } from "./virP9";').replace('router.use("/p8", virP8Router);','router.use("/p8", virP8Router);\nrouter.use("/p9", virP9Router);\nrouter.use("/reception", virReceptionGuestActionsRouter);'));
patch('src/routes/virP9.ts',s=>s
 .replace('ALTER TABLE vir_client_channel_identities ADD COLUMN IF NOT EXISTS lawful_basis text;','ALTER TABLE vir_client_channel_identities ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;\nALTER TABLE vir_client_channel_identities ADD COLUMN IF NOT EXISTS lawful_basis text;')
 .replace('ALTER TABLE vir_communication_touches ADD COLUMN IF NOT EXISTS variant_id uuid;','ALTER TABLE vir_communication_touches ADD COLUMN IF NOT EXISTS variant_id uuid;\nALTER TABLE vir_communication_touches ADD COLUMN IF NOT EXISTS booking_id uuid;')
 .replace("findCalendarGaps(s.locationId,date,{minMinutes:30})","findCalendarGaps(s.locationId,2)")
 .replace("findCalendarGaps(s.locationId,1)","findCalendarGaps(s.locationId,1)")
 .replace("findCalendarGaps(s.locationId,date,{minMinutes:30})","findCalendarGaps(s.locationId,2)")
 .replace("const gaps=await findCalendarGaps(s.locationId,date,{minMinutes:30});const waitlist=await matchWaitlist(s.locationId,date,{limit:50});","const gaps=await findCalendarGaps(s.locationId,1);const waitlist=await matchWaitlist(s.locationId,gaps);")
 .replace("const gaps=await findCalendarGaps(s.locationId,2);const waitlist=await matchWaitlist(s.locationId,date,{limit:50});","const gaps=await findCalendarGaps(s.locationId,1);const waitlist=await matchWaitlist(s.locationId,gaps);")
);
fs.rmSync('scripts/apply-p9-route-patch.cjs');
fs.rmSync('.github/workflows/p9-one-shot-patch.yml');
