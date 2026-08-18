import { access, cp, mkdir } from "node:fs/promises";
import path from "node:path";

const source = path.resolve(process.cwd(), "src", "sql");
const target = path.resolve(process.cwd(), "dist", "sql");

await access(source);
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true, force: true });

console.log(`[build] runtime SQL assets copied: ${source} -> ${target}`);
