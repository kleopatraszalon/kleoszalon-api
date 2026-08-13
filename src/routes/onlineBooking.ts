import {Router} from "express";
import bookingScheduleRouter from "./bookingSchedule";
import onlineBookingResourcesRouter from "./onlineBookingResources";
import onlineBookingCoreRouter from "./onlineBookingCore";

const router=Router();

// A legacy /api/public/booking alias a Stage15.1 erőforrás-előszűrés előtt is
// ugyanazon közzétett munkaidő / nyitvatartás guardon halad át.
router.use((req,res,next)=>{
  if(String(req.baseUrl||"")==="/api/public/booking") return (bookingScheduleRouter as any)(req,res,next);
  return next();
});

// Az Altegio-paritás erőforrásrétege csak akkor válaszol saját maga, ha a
// kiválasztott szolgáltatásoknak erőforrásigényük van. Egyébként változatlanul
// továbbadja a kérést a korábbi online foglalási implementációnak.
router.use(onlineBookingResourcesRouter);
router.use(onlineBookingCoreRouter);

export default router;
