import dotenv from "dotenv";
import db from "../db";
import ensureWorkOrderDemoData from "./ensureWorkOrderDemoData";

dotenv.config();

if (process.env.DEMO_SEED_ENABLED !== "1") {
  console.log("DEMO seed kihagyva. Futtatáshoz állítsd: DEMO_SEED_ENABLED=1");
  process.exit(0);
}

ensureWorkOrderDemoData()
  .then(async () => { await db.end(); process.exit(0); })
  .catch(async (error) => {
    console.error("DEMO seed runner hiba:", error);
    await db.end().catch(() => undefined);
    process.exit(1);
  });
