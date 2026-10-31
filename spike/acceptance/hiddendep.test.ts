// Hidden: a versions the storage format; b's backup/restore (another file) must accept it.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { setup } from "./_cli";

test("feature A: tasks.json is versioned", () => {
  const s = setup();
  s.cli("add", "alpha task");
  const data = JSON.parse(s.raw());
  expect(data.version).toBe(2);
  expect(data.tasks[0].title).toBe("alpha task");
});

test("feature A: old bare-array files still load and are upgraded", () => {
  const s = setup();
  s.write([{ id: 1, title: "legacy task", done: false, createdAt: "2026-01-01T00:00:00.000Z" }]);
  expect(s.cli("list")).toContain("legacy task");
  s.cli("add", "new task");
  expect(JSON.parse(s.raw()).version).toBe(2);
});

test("feature B: backup and restore round-trip", () => {
  const s = setup();
  const backup = join(s.dir, "backup.json");
  s.cli("add", "alpha task");
  s.cli("backup", backup);
  s.cli("add", "beta task");
  s.cli("restore", backup);
  const listing = s.cli("list");
  expect(listing).toContain("alpha task");
  expect(listing).not.toContain("beta task");
});

test("feature B: restore refuses an invalid file", () => {
  const s = setup();
  const bad = join(s.dir, "bad.json");
  s.cli("add", "alpha task");
  Bun.write(bad, '{"nonsense": true}');
  const r = s.run("restore", bad);
  expect(r.code).not.toBe(0);
  expect(s.cli("list")).toContain("alpha task");
});
