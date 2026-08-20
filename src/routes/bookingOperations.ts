import {Router} from "express";
import bookingOperationsCoreRouter from "./bookingOperationsCore";
import bookingAdvancedRouter from "./bookingAdvanced";
import bookingSmartWaitlistRouter from "./bookingSmartWaitlist";
import {startSmartWaitlistAutoWorker} from "../services/smartWaitlistAutoWorker";

const router=Router();
startSmartWaitlistAutoWorker();

// A meglévő várólista/szünet/áthelyezés/ismétlés útvonalak változatlanul megmaradnak.
router.use(bookingOperationsCoreRouter);
// Smart Waitlist: lemondásból kapacitás, rangsorolás, ajánlat és foglalásba emelés.
router.use("/smart-waitlist",bookingSmartWaitlistRouter);
// Stage 15: Altegio-paritás – erőforrások, több szakember és 4Hands.
router.use("/advanced",bookingAdvancedRouter);

export default router;
