// src/app.ts
// Kompatibilitási belépési pont: több build/start konfiguráció az app.ts-t importálja.
// A teljes szerver-konfiguráció (route-ok, CORS, auth, signage, stb.) a server.ts-ben van.

export { default } from "./server";
