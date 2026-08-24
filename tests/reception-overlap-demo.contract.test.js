const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("demo calendar includes parallel appointments with different durations", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src/demo/seedReceptionOverlapAppointments20260824.ts"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "src/server.ts"), "utf8");
  assert.match(source, /durations: \[30, 60, 90\]/);
  assert.match(source, /durations: \[45, 75, 105, 120\]/);
  assert.match(source, /2026-08-24/);
  assert.match(source, /2026-08-30/);
  assert.match(server, /seedReceptionOverlapAppointments20260824/);
});
