// Hidden from the agents: UUID ids (agent a) and short numbers (agent b) must both hold.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), "todo-")), "tasks.json");
  const env = { ...process.env, TODO_FILE: file };
  const cli = (...args: string[]): string => {
    const r = Bun.spawnSync(["bun", "src/cli.ts", ...args], { env });
    if (r.exitCode !== 0) throw new Error(`cli ${args.join(" ")} failed: ${r.stderr}`);
    return r.stdout.toString();
  };
  const tasks = () => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>[];
  cli("add", "alpha task");
  cli("add", "beta task");
  return { cli, tasks };
}

test("feature A: stored ids are UUIDs", () => {
  const { tasks } = setup();
  for (const t of tasks()) expect(String(t.id)).toMatch(UUID);
});

test("feature B: done <n> uses the short number from list", () => {
  const { cli, tasks } = setup();
  expect(cli("list")).toMatch(/\b2\b/);
  cli("done", "2");
  const beta = tasks().find((t) => t.title === "beta task")!;
  expect(beta.done === true || beta.status === "done").toBe(true);
});

test("feature B: delete <n> removes that task", () => {
  const { cli, tasks } = setup();
  cli("delete", "1");
  expect(tasks().map((t) => t.title)).toEqual(["beta task"]);
});
