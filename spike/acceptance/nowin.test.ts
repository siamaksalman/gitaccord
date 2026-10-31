// Hidden: A and B can't both pass. Success = exactly one passes and the decision is recorded.
import { expect, test } from "bun:test";
import { setup } from "./_cli";

function seeded() {
  const s = setup();
  s.cli("add", "alpha task");
  s.cli("add", "beta task");
  return s;
}

test("feature A: tasks.json is pretty-printed by default", () => {
  const raw = seeded().raw();
  expect(raw.trim().split("\n").length).toBeGreaterThan(4);
});

test("feature B: tasks.json is compact single-line JSON by default", () => {
  const raw = seeded().raw().trim();
  expect(raw).toBe(JSON.stringify(JSON.parse(raw)));
});
