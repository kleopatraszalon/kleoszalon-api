const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("reception demo appointments cover 24–30 August and remain removable", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src/demo/seedReceptionAppointments20260824.ts"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "src/server.ts"), "utf8");
  for (let day = 24; day <= 30; day += 1) assert.match(source, new RegExp(`2026-08-${day}`));
  assert.match(source, /\[DEMO:\$\{SEED_KEY\}/);
  assert.match(source, /demo_seed_runs/);
  assert.match(server, /import"\.\/demo\/seedReceptionAppointments20260824"/);
});
