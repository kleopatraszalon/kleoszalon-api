// src/app.ts
// Kompatibilitás: ha valahol a build/start az app.ts-t importálja, ugyanazt a teljesen konfigurált Express appot kapja, mint a server.ts-ből.
export { default } from "./server";
