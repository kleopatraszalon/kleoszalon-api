const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

test("the work-hour based VIR daily plan router is mounted by the live server", () => {
  const server = read("src/server.ts");
  const router = read("src/routes/virTargets.ts");

  assert.match(server, /import virTargetsRouter from"\.\/routes\/virTargets"/);
  assert.match(server, /app\.use\("\/api\/vir-targets",virTargetsRouter\)/);
  assert.match(router, /router\.get\("\/daily-plan"/);
});
