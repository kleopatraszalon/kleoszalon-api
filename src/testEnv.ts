import dotenv from "dotenv";

dotenv.config(); // Betölti a .env fájl tartalmát

console.log("✅ .env fájl beolvasva:");
console.log("PORT =", process.env.PORT);
console.log("DATABASE_URL =", process.env.DATABASE_URL);
