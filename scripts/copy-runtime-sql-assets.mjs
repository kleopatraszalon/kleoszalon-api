import { access, cp, mkdir } from "node:fs/promises";
import path from "node:path";

const copies = [
  [path.resolve(process.cwd(), "src", "sql"), path.resolve(process.cwd(), "dist", "sql")],
  [path.resolve(process.cwd(), "src", "migrations"), path.resolve(process.cwd(), "dist", "migrations")],
];

for (const [source, target] of copies) {
  await access(source);
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true, force: true });
  console.log(`[build] runtime SQL assets copied: ${source} -> ${target}`);
}
