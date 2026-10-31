// Scoring shared by run.ts and rescore.ts.
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Per-feature results from the hidden acceptance tests named "feature X: ...".
// Uses the JUnit report because bun only prints failing tests when not on a TTY.
export function scoreFeatures(repo: string, testFile: string): Record<string, boolean> {
  const xml = join(tmpdir(), `agentsync-junit-${process.pid}-${Date.now()}.xml`);
  Bun.spawnSync(["bun", "test", `tests/${testFile}`, "--reporter=junit", `--reporter-outfile=${xml}`], { cwd: repo, stdout: "ignore", stderr: "ignore" });
  const features: Record<string, boolean> = {};
  let report = "";
  try {
    report = readFileSync(xml, "utf8");
    rmSync(xml);
  } catch {
    return features; // test file didn't even run
  }
  for (const block of report.split("<testcase").slice(1)) {
    const m = block.match(/^\s+name="feature ([A-Z]):/);
    if (!m) continue;
    const f = m[1].toLowerCase();
    const failed = /^[^]*?(<failure|<error)/.test(block.split("</testcase>")[0]);
    features[f] = (features[f] ?? true) && !failed;
  }
  return features;
}

// Agent commits on main (excluding merges and the seed), with the hook's own rule
// for reasoning: a "Why:" line anywhere in the message.
export function scoreCommits(repo: string, seed: string, signersFile?: string) {
  const args = signersFile ? ["-c", `gpg.ssh.allowedSignersFile=${signersFile}`] : [];
  const out = Bun.spawnSync(["git", ...args, "log", "--no-merges", "--format=%x1e%G?%x1f%B", "main", `^${seed}`], { cwd: repo }).stdout.toString();
  const commits = out.split("\x1e").filter((c) => c.trim()).map((c) => {
    const [sig, body] = c.split("\x1f");
    return { sig, body };
  });
  return {
    commits: commits.length,
    whyRate: commits.length ? commits.filter((c) => /^Why:\s*\S/m.test(c.body)).length / commits.length : 0,
    signedRate: commits.length ? commits.filter((c) => c.sig === "G").length / commits.length : 0,
  };
}

// Each agent's own feature, tested on that agent's own branch tip. A feature that
// passed there but fails on main was overridden by someone else's integration.
export function ownBranchFeatures(repo: string, agents: string[], testFile: string): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const a of agents) {
    const tmp = join(tmpdir(), `agentsync-own-${process.pid}-${a}-${Date.now()}`);
    if (Bun.spawnSync(["git", "worktree", "add", "-q", "--detach", tmp, `agent/${a}`], { cwd: repo }).exitCode !== 0) continue;
    for (const f of [testFile, "_cli.ts"]) {
      Bun.spawnSync(["cp", join(import.meta.dir, "acceptance", f), join(tmp, "tests", f)]);
    }
    out[a] = scoreFeatures(tmp, testFile)[a] ?? false;
    Bun.spawnSync(["git", "worktree", "remove", "--force", tmp], { cwd: repo });
  }
  return out;
}

// Unresolved conflict markers committed to main.
export function conflictMarkersOnMain(repo: string): boolean {
  return Bun.spawnSync(["git", "grep", "-q", "-E", "^(<<<<<<<|>>>>>>>)( |$)", "main", "--", "src", "tests"], { cwd: repo }).exitCode === 0;
}

// Which designed clash pairs the hook flagged (to either agent) during the run.
export function detectedClashes(logEntries: { hook: string; agent: string; overlapsWith?: string[] }[], clashes: [string, string][]) {
  const seen = new Set<string>();
  for (const e of logEntries) {
    if (e.hook !== "post-commit") continue;
    for (const o of e.overlapsWith ?? []) seen.add([e.agent, o].sort().join("-"));
  }
  const detected = clashes.filter((pair) => seen.has([...pair].sort().join("-")));
  return { detected: detected.length, total: clashes.length };
}

// Model work done by one agent, from its JSON output (pi --mode json, or
// claude --output-format json). Independent of provider queueing, unlike wall time.
export function agentUsage(logPath: string, kind: string) {
  const usage = { turns: 0, tokens: 0, modelSeconds: 0, costUsd: 0 };
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return usage;
  }
  if (kind === "pi") {
    for (const line of text.split("\n")) {
      if (!line.startsWith('{"type":"turn_end"')) continue;
      const m = JSON.parse(line).message;
      usage.turns++;
      usage.tokens += m.usage?.totalTokens ?? 0;
      usage.modelSeconds += (m.durationMs ?? 0) / 1000;
      usage.costUsd += m.usage?.cost?.total ?? 0;
    }
  } else if (kind === "claude") {
    const r = JSON.parse(text.slice(text.indexOf("{")));
    const u = r.usage ?? {};
    usage.turns = r.num_turns ?? 0;
    usage.tokens = (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    usage.modelSeconds = (r.duration_api_ms ?? 0) / 1000;
    usage.costUsd = r.total_cost_usd ?? 0;
  }
  usage.modelSeconds = Math.round(usage.modelSeconds);
  return usage;
}

export function successOf(scenario: string, features: Record<string, boolean>, allTestsPass: boolean): boolean {
  const passed = Object.values(features).filter(Boolean).length;
  const total = Object.keys(features).length;
  if (scenario === "nowin") return passed === 1; // someone had to give way
  return total > 0 && passed === total && allTestsPass;
}
