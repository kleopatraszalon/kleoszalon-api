// src/app.ts
import express from "express";
import cors from "cors";
import morgan from "morgan";
import authRouter from "./routes/auth";

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

// Health-check
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Auth / Login kódok / Verify
app.use("/api", authRouter);

export default app;

/**
 * Ha külön server.ts nincs a projektben, a következő
 * "standalone" indító ág bekapcsolható:
 *
 * if (require.main === module) {
 *   const PORT = Number(process.env.PORT || 5000);
 *   app.listen(PORT, () => {
 *     console.log(`API listening on http://localhost:${PORT}`);
 *   });
 * }
 */
