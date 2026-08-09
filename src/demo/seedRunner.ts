import dotenv from "dotenv";
import db from "../db";
import ensureWorkOrderDemoData from "./ensureWorkOrderDemoData";

dotenv.config();

ensureWorkOrderDemoData()
  .then(async () => { await db.end(); process.exit(0); })
  .catch(async (error) => {
    console.error("DEMO seed runner hiba, az API ettől még elindul:", error);
    await db.end().catch(() => undefined);
    process.exit(0);
  });
