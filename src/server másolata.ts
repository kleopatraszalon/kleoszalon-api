// src/server.ts
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import pool from "./db";
import menuRoutes from "./routes/menu";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// --- Közös beállítások ---
app.use(cors({
  origin: [
   
    "http://localhost:3001", // <-- hozzáadva
    "http://127.0.0.1:3001", // <-- hozzáadva
    " http://10.40.23.26:3001", // <-- hozzáadva
   
  ],
  credentials: true,
}));

app.use(express.json());

// --- Teszt endpoint ---
app.get("/", (_req, res) => {
  res.send("✅ Backend fut és CORS be van állítva");
});

// --- Menü routes ---
app.use("/api/menus", menuRoutes);

/* REGISZTRÁCIÓ */
app.post("/api/register", async (req, res) => {
  const { name, email, password, phone, gender, birth_year, address } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Hiányzó adatok" });

  try {
    const exists = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
    if (exists.rows.length > 0) return res.status(400).json({ error: "E-mail már létezik" });

    const password_hash = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO users 
        (name, email, phone, gender, birth_year, address, password_hash, role, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'employee','pending',NOW())
       RETURNING id,name,email,role,status`,
      [name, email, phone, gender, birth_year, address, password_hash]
    );

    res.status(201).json({ message: "Sikeres regisztráció, admin jóváhagyásra vár.", user: result.rows[0] });
  } catch (err) {
    console.error("❌ Regisztrációs hiba:", err);
    res.status(500).json({ error: "Adatbázis hiba" });
  }
});

/* BELÉPTETÉS */
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const result = await pool.query("SELECT id,email,password_hash,role,status FROM users WHERE email=$1", [email]);
    if (result.rows.length === 0) return res.status(401).json({ success:false, error:"Hibás e-mail vagy jelszó" });

    const user = result.rows[0];
    if (user.status !== "active") return res.status(403).json({ success:false, error:"Fiók még nincs aktiválva" });

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) return res.status(401).json({ success:false, error:"Hibás e-mail vagy jelszó" });

    const token = jwt.sign({ id:user.id,email:user.email,role:user.role }, process.env.JWT_SECRET || "secret", { expiresIn:"8h" });

    res.json({ success:true, message:"Sikeres bejelentkezés", token, role:user.role || "guest" });
  } catch(err) {
    console.error("❌ Belépési hiba:", err);
    res.status(500).json({ success:false, error:"Hiba történt a belépés során" });
  }
});

/* 2FA TESZT */
app.post("/api/verify-code", (req, res) => {
  const { email, code } = req.body;
  if(code === "123456") {
    const token = jwt.sign({ email }, process.env.JWT_SECRET || "secret", { expiresIn:"8h" });
    res.json({ success:true, token });
  } else {
    res.status(400).json({ success:false, error:"Érvénytelen kód" });
  }
});

/* SZOLGÁLTATÁSOK CRUD */
app.get("/api/services", async (_req, res) => {
  try {
    const result = await pool.query("SELECT id,name,price,duration,description FROM services ORDER BY name ASC");
    res.json(result.rows);
  } catch(err) {
    console.error("❌ Error fetching services:", err);
    res.status(500).json({ error:"Error fetching services" });
  }
});

/* TESZT ADATOK */
app.get("/api/events", (_req,res) => {
  res.json([{ id:1,title:"Teszt esemény",start_time:"2025-11-01T09:00:00",end_time:"2025-11-01T10:00:00",employee_id:1,client_id:2,service_id:3,status:"confirmed",price:10000,payment_method:"készpénz",notes:"Próba esemény"}]);
});
app.get("/api/employees", (_req,res) => res.json([{id:1,name:"Teszt Dolgozó",color:"#4caf50"}]));
app.get("/api/clients", (_req,res) => res.json([{id:2,name:"Vendég Klára"}]));

// --- Szerver indítása biztonságos hibakezeléssel ---
const server = app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use. Kill the process or change the PORT in .env`);
  } else {
    console.error(err);
  }
});
