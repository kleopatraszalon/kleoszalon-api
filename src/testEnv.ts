import dotenv from "dotenv";

dotenv.config(); // Betölti a .env fájl tartalmát

console.log("✅ .env fájl beolvasva:");
console.log("PORT =", process.env.PORT);
console.log("DATABASE_URL =", process.env.DATABASE_URL);

const { DATABASE_URL, JWT_SECRET } = process.env as {
  DATABASE_URL?: string;
  JWT_SECRET?: string;
};

console.log("DB:", DATABASE_URL);
console.log("JWT:", JWT_SECRET);

