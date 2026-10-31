// Runs several spike runs, a few at a time, and prints metrics tables.
// Usage: bun batch.ts [--parallel N] <scenario:mode:repeats>... -- <pi|claude> [agent args...]
// e.g.   bun batch.ts --parallel 4 nowin:baseline:2 nowin:coord:2 -- pi --model 9router/ollama/glm-5.3-flash
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadResults, perRunTable, summaryTable } from "./metrics";
import { SCENARIOS } from "./scenarios";

const SPIKE = import.meta.dir;
let argv = process.argv.slice(2);
let parallel = 4;
if (argv[0] === "--parallel") {
  parallel = Number(argv[1]);
  argv = argv.slice(2);
}
const sep = argv.indexOf("--");
const specs = argv.slice(0, sep === -1 ? undefined : sep);
const agentArgs = sep === -1 ? [] : argv.slice(sep + 1);

// scenario:mode:repeats[:order], where order names the agent that starts first.
const queue = specs.flatMap((spec) => {
  const [scenario, mode, repeats = "1", order = ""] = spec.split(":");
  return Array.from({ length: Number(repeats) }, () => [scenario, mode, order]);
});

// Refuse malformed specs up front (e.g. a whole list passed as one word).
for (const [scenario, mode, order] of queue) {
  const s = SCENARIOS[scenario];
  if (!s || !["baseline", "coord", "remote"].includes(mode) || (order && !(order in s.features))) {
    console.error(`invalid run spec: scenario=${JSON.stringify(scenario)} mode=${JSON.stringify(mode)} order=${JSON.stringify(order)}`);
    process.exit(1);
  }
}
if (specs.some((s) => Number.isNaN(Number(s.split(":")[2] ?? "1")))) {
  console.error("invalid repeat count in specs");
  process.exit(1);
}
console.log(`queued ${queue.length} runs`);

const runsDir = join(SPIKE, "runs");
const before = new Set(existsSync(runsDir) ? readdirSync(runsDir) : []);

// Runs that fail for infrastructure reasons (timeout, agent crash) are retried
// once; the failed attempt stays on disk and is counted as an infra failure.
const retried = new Set<number>();

const jobs = queue.map((job, id) => ({ job, id }));
async function worker() {
  while (jobs.length) {
    const { job, id } = jobs.shift()!;
    const [scenario, mode, order] = job;
    const p = Bun.spawn(["bun", join(SPIKE, "run.ts"), scenario, mode, ...agentArgs], {
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, ORDER: order },
    });
    await p.exited;
    console.log(`done: ${scenario} ${mode}${order ? ` order=${order}` : ""} (exit ${p.exitCode})`);
    if (p.exitCode !== 0 && !retried.has(id)) {
      retried.add(id);
      jobs.push({ job, id });
      console.log(`  retrying ${scenario} ${mode} once`);
    }
    await Bun.sleep(1500); // distinct timestamps for run dirs
  }
}
await Promise.all(Array.from({ length: parallel }, (_, i) => Bun.sleep(i * 1500).then(worker)));

const rows = loadResults(runsDir)
  .filter((r) => !before.has(r.runDir?.split("/").pop() ?? ""))
  .filter((r) => r.agent === agentArgs[0]); // another batch may be running alongside
console.log("\n" + summaryTable(rows) + "\n\n" + perRunTable(rows));
