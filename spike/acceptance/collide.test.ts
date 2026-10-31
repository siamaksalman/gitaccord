// Hidden from the agents: copied into the merged repo only at evaluation time.
// Checks that both features work together after merging.
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = { ...process.env, TODO_FILE: join(mkdtempSync(join(tmpdir(), "todo-")), "tasks.json") };

function cli(...args: string[]): string {
  const r = Bun.spawnSync(["bun", "src/cli.ts", ...args], { env });
  if (r.exitCode !== 0) throw new Error(`cli ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.toString();
}

test("feature A: tasks have status, priority and due date", () => {
  cli("add", "write report", "--priority", "high", "--due", "2026-12-01");
  cli("status", "1", "doing");
  const listing = cli("list");
  expect(listing).toContain("write report");
  expect(listing.toLowerCase()).toContain("high");
});

test("feature B: CSV export covers the new task fields", () => {
  const [header, ...rows] = cli("export", "--csv").trim().split("\n");
  const cols = header.split(",").map((c) => c.trim().toLowerCase());
  expect(cols).toContain("title");
  expect(cols).toContain("status");
  expect(cols).toContain("priority");
  expect(cols.some((c) => c.startsWith("due"))).toBe(true);
  expect(cols).not.toContain("done");
  const row = rows.find((r) => r.includes("write report"))!;
  expect(row).toContain("high");
  expect(row).toContain("doing");
  expect(row).toContain("2026-12-01");
});
