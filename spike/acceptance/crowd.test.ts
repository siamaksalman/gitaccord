// Hidden: six features from six agents must all work together on main.
import { expect, test } from "bun:test";
import { setup } from "./_cli";

function seeded() {
  const s = setup();
  s.cli("add", "alpha task", "--priority", "high", "--due", "2026-12-05", "--tag", "work");
  s.cli("add", "beta task", "--priority", "low", "--due", "2026-11-01");
  s.cli("add", "gamma task", "--tag", "home");
  s.cli("status", "1", "doing");
  return s;
}

test("feature A: tasks have status, priority and due date", () => {
  const listing = seeded().cli("list");
  expect(listing).toContain("alpha task");
  expect(listing.toLowerCase()).toContain("high");
});

test("feature B: CSV export covers the new task fields", () => {
  const [header, ...rows] = seeded().cli("export", "--csv").trim().split("\n");
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  expect(cols).toContain("status");
  expect(cols).toContain("priority");
  expect(cols).not.toContain("done");
  const row = rows.find((r) => r.includes("alpha task"))!;
  expect(row).toContain("high");
  expect(row).toContain("doing");
});

test("feature C: filter by status and priority, sort by due", () => {
  const s = seeded();
  const doing = s.cli("list", "--status", "doing");
  expect(doing).toContain("alpha task");
  expect(doing).not.toContain("beta task");
  const sorted = s.cli("list", "--sort", "due");
  expect(sorted.indexOf("beta task")).toBeLessThan(sorted.indexOf("alpha task"));
  expect(sorted.indexOf("alpha task")).toBeLessThan(sorted.indexOf("gamma task"));
});

test("feature D: tags", () => {
  const s = seeded();
  const work = s.cli("list", "--tag", "work");
  expect(work).toContain("alpha task");
  expect(work).not.toContain("beta task");
  expect(s.cli("list")).toContain("#home");
});

test("feature E: edit and delete", () => {
  const s = seeded();
  s.cli("edit", "2", "beta renamed");
  s.cli("delete", "3");
  const listing = s.cli("list");
  expect(listing).toContain("beta renamed");
  expect(listing).not.toContain("gamma task");
});

test("feature F: stats by status", () => {
  const out = seeded().cli("stats");
  expect(out).toMatch(/doing:\s*1/);
  expect(out).toMatch(/todo:\s*2/);
});
