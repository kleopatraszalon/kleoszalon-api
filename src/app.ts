// src/app.ts
// A szerver indulását kizárólag a src/server.ts végzi.
// Ez a fájl történeti kompatibilitási helyőrző; ne importálja a servert,
// mert az app.listen() mellékhatást okozna és build-time default exportot várt.
export {};
