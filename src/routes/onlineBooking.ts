import {Router} from "express";
import bookingScheduleRouter from "./bookingSchedule";
import onlineBookingHealthRouter from "./onlineBookingHealth";
import onlineBookingClientBlockRouter from "./onlineBookingClientBlock";
import onlineBookingResourcesRouter from "./onlineBookingResources";
import onlineBookingCoreRouter from "./onlineBookingCore";

const router=Router();

router.use((req,res,next)=>{
  if(String(req.baseUrl||"")==="/api/public/booking") return (bookingScheduleRouter as any)(req,res,next);
  return next();
});

// Production health is deliberately read-only and mounted before mutation-capable layers.
router.use(onlineBookingHealthRouter);

// Stage16 CRM governance: a tiltólistás ügyfél sem közvetlen online foglalást,
// sem online várólista-bejegyzést nem hozhat létre. A tiltás indoka nem kerül ki publikus válaszba.
router.use(onlineBookingClientBlockRouter);
router.use(onlineBookingResourcesRouter);
router.use(onlineBookingCoreRouter);

export default router;
