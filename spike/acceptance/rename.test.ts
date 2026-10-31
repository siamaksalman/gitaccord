// Hidden: a renames title -> text; b's search/edit must work on the renamed field.
import { expect, test } from "bun:test";
import { setup } from "./_cli";

test("feature A: tasks are stored with text, not title", () => {
  const s = setup();
  s.cli("add", "alpha task");
  const [t] = s.tasks();
  expect(t.text).toBe("alpha task");
  expect(t.title).toBeUndefined();
});

test("feature A: old files using title still load", () => {
  const s = setup();
  s.write([{ id: 1, title: "legacy task", done: false, createdAt: "2026-01-01T00:00:00.000Z" }]);
  expect(s.cli("list")).toContain("legacy task");
});

test("feature B: search finds tasks case-insensitively", () => {
  const s = setup();
  s.cli("add", "Buy Milk");
  s.cli("add", "walk dog");
  const out = s.cli("search", "milk");
  expect(out).toContain("Buy Milk");
  expect(out).not.toContain("walk dog");
});

test("feature B: edit changes a task's text", () => {
  const s = setup();
  s.cli("add", "Buy Milk");
  s.cli("add", "walk dog");
  s.cli("edit", "2", "walk cat");
  expect(s.cli("list")).toContain("walk cat");
  expect(s.cli("search", "cat")).toContain("walk cat");
});
