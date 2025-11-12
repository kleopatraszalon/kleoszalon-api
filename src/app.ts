// src/app.ts (SERVER SIDE - no JSX)
import express from "express";
import cors from "cors";
import morgan from "morgan";

const app = express();

// Middlewares
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

// Health check
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

// TODO: mount your API routes here, e.g.:
// import authRouter from "./routes/auth";
// app.use("/api/auth", authRouter);

export default app;
