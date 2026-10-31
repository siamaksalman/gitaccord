// Spike runner: agents build features in parallel and land them on main
// themselves; then we test main and compute metrics.
//
// Usage: bun run.ts <scenario> <baseline|coord|remote> <pi|claude> [agent args...]
//   baseline  plain git, one machine (worktrees)
//   coord     agentsync hook + conventions + signing, one machine (worktrees)
//   remote    as coord, but every agent works in its own clone of a shared remote
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SCENARIOS } from "./scenarios";
import { agentUsage, conflictMarkersOnMain, detectedClashes, ownBranchFeatures, scoreCommits, scoreFeatures, successOf } from "./score";

const SPIKE = import.meta.dir;
const [scenarioName, mode, agentKind] = process.argv.slice(2);
const scenario = SCENARIOS[scenarioName];
if (!scenario || !["baseline", "coord", "remote"].includes(mode) || !["pi", "claude", "noop"].includes(agentKind)) {
  // noop: agents do nothing; exercises setup and metrics without model calls
  console.error(`usage: bun run.ts <${Object.keys(SCENARIOS).join("|")}> <baseline|coord|remote> <pi|claude|noop> [agent args...]`);
  process.exit(1);
}
const agentArgs = process.argv.slice(5);
const order = process.env.ORDER ?? "";
const orderDelay = Number(process.env.ORDER_DELAY ?? 60);
// Hook and protocol versions (defaults: the versions earlier batches used).
const hookFile = process.env.HOOK ?? "agentsync.ts";
const protocolFile = process.env.PROTOCOL ?? "AGENTS.md";
const coordinated = mode !== "baseline";
const remote = mode === "remote";

function agentCommand(prompt: string): string[] {
  if (agentKind === "noop") return ["true"];
  // JSON output so each agent's turns, tokens and model time can be measured.
  if (agentKind === "pi") return ["pi", "-p", "--no-session", "-a", "--mode", "json", ...agentArgs, prompt];
  // Project settings only: keep the user's own plugins, hooks and MCP servers out of the test.
  return [
    "claude", "-p", "--setting-sources", "project", "--strict-mcp-config",
    "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write,Glob,Grep", "--output-format", "json",
    ...agentArgs, prompt,
  ];
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = resolve(SPIKE, "runs", `${scenarioName}-${mode}-${agentKind}-${stamp}`);
const repo = join(runDir, "repo");
const keys = join(runDir, "keys");
mkdirSync(repo, { recursive: true });
mkdirSync(keys);

function sh(cwd: string, ...cmd: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe" });
  return { ok: r.exitCode === 0, out: (r.stdout.toString() + r.stderr.toString()).trim() };
}
function git(cwd: string, ...args: string[]) {
  const r = sh(cwd, "git", ...args);
  if (!r.ok) throw new Error(`git ${args.join(" ")}: ${r.out}`);
  return r.out;
}

const agents = Object.keys(scenario.features);

// ---- seed ------------------------------------------------------------------

cpSync(join(SPIKE, "toy"), repo, { recursive: true });
writeFileSync(join(repo, ".gitignore"), "node_modules\ntasks.json\n");
if (coordinated) {
  mkdirSync(join(repo, ".agents"));
  cpSync(join(SPIKE, "protocol", protocolFile), join(repo, "AGENTS.md"));
  if (hookFile !== "agentsync.ts") writeFileSync(join(repo, ".agents", "config.json"), '{ "test": "bun test {files}" }\n');
  writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md\n"); // Claude Code reads CLAUDE.md, not AGENTS.md
  writeFileSync(join(repo, ".agents", "direction.md"), scenario.direction);
  const signers = agents.map((name) => {
    sh(keys, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", name, "-f", `key-${name}`);
    const pub = readFileSync(join(keys, `key-${name}.pub`), "utf8").split(" ").slice(0, 2).join(" ");
    return `${name}@agents.local ${pub}`;
  });
  writeFileSync(join(repo, ".agents", "allowed_signers"), signers.join("\n") + "\n");
}
git(repo, "init", "-q", "-b", "main");
git(repo, "add", "-A");
git(repo, "-c", "user.name=seed", "-c", "user.email=seed@local", "commit", "-q", "-m", "seed");
const seed = git(repo, "rev-parse", "HEAD");

function installHooks(gitDir: string) {
  const hook = join(SPIKE, "hook", hookFile);
  for (const name of ["pre-commit", "commit-msg", "post-commit", "post-merge", "pre-push"]) {
    writeFileSync(join(gitDir, "hooks", name), `#!/bin/sh\nexec "${Bun.which("bun")}" "${hook}" ${name} "$@"\n`, { mode: 0o755 });
  }
}

const origin = join(runDir, "origin.git");
if (remote) git(runDir, "clone", "-q", "--bare", repo, origin);
else if (coordinated) installHooks(join(repo, ".git"));
git(repo, "checkout", "-q", "--detach"); // leave main free for `git push . HEAD:main` and later fetches

// ---- agents ----------------------------------------------------------------

const landing = remote
  ? ["`git fetch origin` then `git merge origin/main`", "`git push origin HEAD:main`"]
  : ["`git merge main`", "`git push . HEAD:main`"];

const started = Date.now();
const runs = agents.map((name) => {
  const wt = join(runDir, `wt-${name}`);
  if (remote) {
    git(runDir, "clone", "-q", origin, wt);
    git(wt, "checkout", "-q", "-b", `agent/${name}`);
    installHooks(join(wt, ".git"));
  } else {
    git(repo, "worktree", "add", "-q", "-b", `agent/${name}`, wt);
  }
  // Identity via env: `git config` in a worktree writes the shared repo config.
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: `agent-${name}`, GIT_AUTHOR_EMAIL: `${name}@agents.local`,
    GIT_COMMITTER_NAME: `agent-${name}`, GIT_COMMITTER_EMAIL: `${name}@agents.local`,
  };
  if (coordinated) {
    Object.assign(env, {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "gpg.format", GIT_CONFIG_VALUE_0: "ssh",
      GIT_CONFIG_KEY_1: "user.signingkey", GIT_CONFIG_VALUE_1: join(keys, `key-${name}`),
      GIT_CONFIG_KEY_2: "commit.gpgsign", GIT_CONFIG_VALUE_2: "true",
    });
  }
  const prompt = [
    `You are agent "${name}". Implement this in the current repository (a TypeScript app run with bun):`,
    "",
    scenario.features[name],
    "",
    "Run `bun test` to check your work. Commit everything to the current branch with clear commit messages",
    "that explain why. Do not switch branches and do not touch other directories.",
    "",
    "When your feature is done, land it on main yourself. Your work isn't finished until it's on main:",
    `1. ${landing[0]}, which brings in anything other agents already landed. Resolve any conflicts so that`,
    "   everyone's features keep working.",
    "2. `bun test`, which must pass.",
    `3. ${landing[1]}. If it's rejected because main moved, start again from step 1.`,
  ].join("\n");
  // Landing-order control: with ORDER=<agent>, that agent starts first and the
  // others start ORDER_DELAY seconds later.
  const delay = order && name !== order ? orderDelay : 0;
  const proc = Bun.sleep(delay * 1000).then(() => {
    console.log(`starting agent ${name} in ${wt}`);
    return Bun.spawn(agentCommand(prompt), {
      cwd: wt,
      env: { ...process.env, ...env },
      stdout: Bun.file(join(runDir, `agent-${name}.log`)),
      stderr: Bun.file(join(runDir, `agent-${name}.err.log`)),
    });
  });
  return { name, wt, proc, seconds: 0, exitCode: 0 as number | null };
});

// Provider stalls (an API request hanging for many minutes) are infrastructure
// failures, not results: stop agents that pass RUN_TIMEOUT seconds.
const runTimeout = Number(process.env.RUN_TIMEOUT ?? 1200);
let timedOut = false;
const watchdog = setTimeout(async () => {
  timedOut = true;
  for (const r of runs) (await r.proc).kill();
}, runTimeout * 1000);
for (const r of runs) {
  const p = await r.proc;
  await p.exited;
  r.exitCode = p.exitCode;
  r.seconds = Math.round((Date.now() - started) / 1000);
  console.log(`agent ${r.name} finished (exit ${r.exitCode}) after ${r.seconds}s`);
}
clearTimeout(watchdog);
const failed = runs.filter((r) => r.exitCode !== 0);
if (timedOut || failed.length) {
  const error = timedOut ? `timeout after ${runTimeout}s` : "agent failed";
  console.error(`${error}: ${failed.map((r) => r.name).join(", ")}; see agent-*.err.log in ${runDir}. Not evaluating.`);
  writeFileSync(join(runDir, "result.json"), JSON.stringify({ scenario: scenarioName, mode, agent: agentKind, runDir, order, error }));
  process.exit(1);
}

// ---- evaluate main ---------------------------------------------------------

// Bring main and every agent branch into `repo` so all metrics read one place.
if (remote) {
  git(repo, "fetch", "-q", origin, "+refs/heads/*:refs/heads/*");
  for (const r of runs) git(repo, "fetch", "-q", r.wt, `+HEAD:refs/heads/agent/${r.name}`);
}
git(repo, "checkout", "-q", "-f", "main");

// Landed = none of the agent's own code commits are missing from main
// (trailing coordination-only commits after landing don't count).
const landed = Object.fromEntries(
  agents.map((a) => [a, git(repo, "log", "--no-merges", "--format=%H", `main..agent/${a}`, "--", ".", ":(exclude).agents").length === 0]),
);

const projectTests = sh(repo, "bun", "test"); // main's own tests, before the hidden ones are added
cpSync(join(SPIKE, "acceptance", scenario.acceptance), join(repo, "tests", scenario.acceptance));
cpSync(join(SPIKE, "acceptance", "_cli.ts"), join(repo, "tests", "_cli.ts"));
const acceptance = sh(repo, "bun", "test", `tests/${scenario.acceptance}`);
const final = sh(repo, "bun", "test");

const features = scoreFeatures(repo, scenario.acceptance);
const featuresPassed = Object.values(features).filter(Boolean).length;
const featureCount = Object.keys(features).length;
const success = successOf(scenarioName, features, final.ok);

// Merge conflicts the agents had to resolve on their way to main.
let conflictsResolved = 0;
for (const merge of git(repo, "rev-list", "--merges", "main", `^${seed}`).split("\n").filter(Boolean)) {
  const [p1, p2] = git(repo, "log", "-1", "--format=%P", merge).split(" ");
  if (!sh(repo, "git", "merge-tree", "--write-tree", p1, p2).ok) conflictsResolved++;
}

// Agent commits on main: reasoning and signatures.
const commitScore = scoreCommits(repo, seed, coordinated ? join(repo, ".agents", "allowed_signers") : undefined);

const notes = new Set(
  ["main", ...agents.map((a) => `agent/${a}`)].flatMap((ref) =>
    sh(repo, "git", "ls-tree", "--name-only", ref, ".agents/notes/").out.split("\n").filter(Boolean),
  ),
).size;
const directionChanges = coordinated ? git(repo, "log", "--format=%H", "main", `^${seed}`, "--", ".agents/direction.md").split("\n").filter(Boolean).length : 0;
const grepMain = (pattern: string) =>
  coordinated ? sh(repo, "git", "grep", "-i", "-c", "-E", pattern, "main", "--", ".agents").out.split("\n").filter(Boolean).length : 0;
const decisionRecorded = grepMain("decid|decision|agree|chose|trade-?off") > 0;
const escalated = grepMain("human|escalat|maintainer|product owner") > 0;

// Hook logs (one per clone in remote mode, one shared in local mode).
const logFiles = remote ? runs.map((r) => join(r.wt, ".git", "agentsync", "log.jsonl")) : [join(repo, ".git", "agentsync", "log.jsonl")];
const log = logFiles
  .filter(existsSync)
  .flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const postCommits = log.filter((e) => e.hook === "post-commit");
const notices = postCommits.filter((e) => e.bytes > 0);
const firstOverlap: Record<string, number> = {};
for (const e of postCommits) {
  if (e.overlapsWith.length && firstOverlap[e.agent] === undefined) firstOverlap[e.agent] = Math.round((e.ts - started) / 1000);
}
const hookMs = postCommits.map((e) => e.ms);

const metrics = {
  scenario: scenarioName,
  mode,
  agent: agentKind,
  runDir,
  success,
  features,
  intentPreserved: featureCount ? featuresPassed / featureCount : 0,
  landed: Object.values(landed).filter(Boolean).length,
  agents: agents.length,
  allTestsPass: final.ok,
  conflictsResolved,
  commits: commitScore.commits,
  whyRate: commitScore.whyRate,
  signedRate: commitScore.signedRate,
  notes,
  directionChanges,
  decisionRecorded,
  escalated,
  notices: notices.length,
  noticeBytes: notices.reduce((s, e) => s + e.bytes, 0),
  rejectedCommits: log.filter((e) => e.hook === "commit-msg" && e.rejected).length,
  rejections: Object.fromEntries(
    ["pre-commit", "commit-msg", "pre-push"].map((h) => [h, log.filter((e) => e.hook === h && e.rejected).length]),
  ),
  unverifiedBlocked: postCommits.reduce((s, e) => s + (e.unverified ?? 0), 0),
  hookMsAvg: hookMs.length ? Math.round(hookMs.reduce((s, x) => s + x, 0) / hookMs.length) : 0,
  hookMsMax: hookMs.length ? Math.max(...hookMs) : 0,
  firstOverlapSeconds: firstOverlap,
  seconds: Math.max(...runs.map((r) => r.seconds)),
  order,
  projectTestsPass: projectTests.ok,
  hook: hookFile,
  overridesDeclared: [...new Set(log.flatMap((e) => (e.hook === "pre-push" && !e.rejected ? e.overrides ?? [] : [])))],
  gateBrokeTests: log.filter((e) => e.hook === "pre-push" && e.broken).length,
  ...totalUsage(),
  ...outcomeMetrics(features, projectTests.ok, decisionRecorded, log),
};

// Model work summed over all agents in the run.
function totalUsage() {
  const per = Object.fromEntries(agents.map((a) => [a, agentUsage(join(runDir, `agent-${a}.log`), agentKind)]));
  const sum = (k: "turns" | "tokens" | "modelSeconds" | "costUsd") => Object.values(per).reduce((s, u) => s + u[k], 0);
  return { usage: per, turns: sum("turns"), tokens: sum("tokens"), modelSeconds: sum("modelSeconds"), costUsd: Math.round(sum("costUsd") * 100) / 100 };
}

// Primary and guardrail metrics (see the design doc's "Success metrics").
function outcomeMetrics(mainFeatures: Record<string, boolean>, testsPass: boolean, recorded: boolean, entries: any[]) {
  const own = ownBranchFeatures(repo, agents, scenario.acceptance);
  const overridden = agents.filter((a) => own[a] && mainFeatures[a] === false);
  const markers = conflictMarkersOnMain(repo);
  const detection = coordinated ? detectedClashes(entries, scenario.clashes) : { detected: 0, total: scenario.clashes.length };
  return {
    ownFeatures: own,
    overridden,
    silentOverrides: recorded ? 0 : overridden.length,
    conflictMarkers: markers,
    brokenMain: markers || !testsPass,
    clashesDetected: detection.detected,
    clashesTotal: detection.total,
  };
}

const report = [
  `# Spike run: ${scenarioName} / ${mode} / ${agentKind}`,
  "",
  "```json",
  JSON.stringify(metrics, null, 2),
  "```",
  "",
  "## main",
  "```",
  git(repo, "log", "--oneline", "--graph", "main"),
  "```",
  "",
  "## Acceptance tests",
  "```",
  acceptance.out.slice(-4000),
  "```",
];
writeFileSync(join(runDir, "report.md"), report.join("\n"));
writeFileSync(join(runDir, "result.json"), JSON.stringify(metrics));
console.log(report.join("\n"));
