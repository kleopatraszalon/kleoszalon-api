import {Router} from "express";
import bookingScheduleRouter from "./bookingSchedule";
import onlineBookingHealthRouter from "./onlineBookingHealth";
import onlineBookingClientBlockRouter from "./onlineBookingClientBlock";
import onlineBookingSkillGuardRouter from "./onlineBookingSkillGuard";
import onlineBookingResourcesRouter from "./onlineBookingResources";
import onlineBookingNbaAttributionRouter from "./onlineBookingNbaAttribution";
import bookingGlobalCatalogRouter from "./bookingGlobalCatalog";
import onlineBookingCoreRouter from "./onlineBookingCore";

const router=Router();

router.use((req,res,next)=>{
  if(String(req.baseUrl||"")==="/api/public/booking") return (bookingScheduleRouter as any)(req,res,next);
  return next();
});

// Production health is deliberately read-only and mounted before mutation-capable layers.
router.use(onlineBookingHealthRouter);

// NBA attribution is public but opaque: it never exposes CRM details and validates
// the marketing job -> customer -> persisted appointment chain server-side.
router.use(onlineBookingNbaAttributionRouter);

// Location-independent catalog lets guests choose the service before a salon.
router.use(bookingGlobalCatalogRouter);

// Stage16 CRM governance: a tiltólistás ügyfél sem közvetlen online foglalást,
// sem online várólista-bejegyzést nem hozhat létre. A tiltás indoka nem kerül ki publikus válaszba.
router.use(onlineBookingClientBlockRouter);

// VIR Wave II: a skill-mátrix mostantól operatív foglalási korlát is. A guard
// a régi override-kompatibilitást megtartja, de tiltott vagy lejárt képesítésű
// munkatársat nem enged szabad időpontként megjelenni és nem enged lefoglalni.
router.use(onlineBookingSkillGuardRouter);
router.use(onlineBookingResourcesRouter);
router.use(onlineBookingCoreRouter);

export default router;