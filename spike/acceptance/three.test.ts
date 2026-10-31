// Hidden from the agents: checks all three features work together after merging.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function freshCli() {
  const env = { ...process.env, TODO_FILE: join(mkdtempSync(join(tmpdir(), "todo-")), "tasks.json") };
  return (...args: string[]): string => {
    const r = Bun.spawnSync(["bun", "src/cli.ts", ...args], { env });
    if (r.exitCode !== 0) throw new Error(`cli ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.toString();
  };
}

function seed() {
  const cli = freshCli();
  cli("add", "alpha task", "--priority", "high", "--due", "2026-12-05");
  cli("add", "beta task", "--priority", "low", "--due", "2026-11-01");
  cli("add", "gamma task");
  cli("status", "1", "doing");
  return cli;
}

test("feature A: tasks have status, priority and due date", () => {
  const listing = seed()("list");
  expect(listing).toContain("alpha task");
  expect(listing.toLowerCase()).toContain("high");
});

test("feature B: CSV export covers the new task fields", () => {
  const [header, ...rows] = seed()("export", "--csv").trim().split("\n");
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  expect(cols).toContain("status");
  expect(cols).toContain("priority");
  expect(cols.some((c) => c.startsWith("due"))).toBe(true);
  expect(cols).not.toContain("done");
  const row = rows.find((r) => r.includes("alpha task"))!;
  expect(row).toContain("high");
  expect(row).toContain("doing");
});

test("feature C: filter by status and priority", () => {
  const cli = seed();
  const doing = cli("list", "--status", "doing");
  expect(doing).toContain("alpha task");
  expect(doing).not.toContain("beta task");
  const low = cli("list", "--priority", "low");
  expect(low).toContain("beta task");
  expect(low).not.toContain("alpha task");
});

test("feature C: sort by due date, undated last", () => {
  const out = seed()("list", "--sort", "due");
  const [b, a, g] = ["beta task", "alpha task", "gamma task"].map((t) => out.indexOf(t));
  expect(b).toBeGreaterThanOrEqual(0);
  expect(b).toBeLessThan(a);
  expect(a).toBeLessThan(g);
});
