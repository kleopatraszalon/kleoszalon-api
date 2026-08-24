const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("timetable exposes the appointment creation timestamp for calendar cards", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src/routes/timetable.ts"), "utf8");
  assert.match(source, /NULLIF\(to_jsonb\(a\)->>'created_at',''\) AS created_at/);
});
