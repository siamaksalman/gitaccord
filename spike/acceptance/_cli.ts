// Shared helper for the hidden acceptance tests: a CLI bound to a fresh tasks file.
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function setup() {
  const dir = mkdtempSync(join(tmpdir(), "todo-"));
  const file = join(dir, "tasks.json");
  const env = { ...process.env, TODO_FILE: file };
  const run = (...args: string[]) => {
    const r = Bun.spawnSync(["bun", "src/cli.ts", ...args], { env });
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
  };
  const cli = (...args: string[]): string => {
    const r = run(...args);
    if (r.code !== 0) throw new Error(`cli ${args.join(" ")} failed: ${r.err}`);
    return r.out;
  };
  const raw = () => readFileSync(file, "utf8");
  const write = (content: unknown) => writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  // Tasks regardless of whether the file is a bare array or { tasks: [...] }.
  const tasks = (): Record<string, any>[] => {
    const data = JSON.parse(raw());
    return Array.isArray(data) ? data : data.tasks;
  };
  return { dir, file, run, cli, raw, write, tasks };
}
