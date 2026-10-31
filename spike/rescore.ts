// Re-score finished runs with the current scoring (score.ts), in place.
// Usage: bun rescore.ts [--since <run-dir-timestamp>]
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SCENARIOS } from "./scenarios";
import { conflictMarkersOnMain, detectedClashes, ownBranchFeatures, scoreCommits, scoreFeatures, successOf } from "./score";

const runsDir = join(import.meta.dir, "runs");
const i = process.argv.indexOf("--since");
const since = i === -1 ? "" : process.argv[i + 1];

for (const d of readdirSync(runsDir)) {
  if ((d.match(/(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/)?.[1] ?? "") < since) continue;
  const resultFile = join(runsDir, d, "result.json");
  if (!existsSync(resultFile)) continue;
  const r = JSON.parse(readFileSync(resultFile, "utf8"));
  if (r.error || r.agent === "noop" || r.success === undefined) continue;
  const repo = join(runsDir, d, "repo");
  const scenario = SCENARIOS[r.scenario];
  const seed = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "main"], { cwd: repo }).stdout.toString().trim();
  const signers = join(repo, ".agents", "allowed_signers");
  r.features = scoreFeatures(repo, scenario.acceptance);
  const passed = Object.values(r.features).filter(Boolean).length;
  r.intentPreserved = passed / Math.max(1, Object.keys(r.features).length);
  r.success = successOf(r.scenario, r.features, r.allTestsPass);
  Object.assign(r, scoreCommits(repo, seed, existsSync(signers) ? signers : undefined));
  delete r.whyTrailerRate;
  delete r.whyInSubject;

  // Project tests on main without the hidden acceptance files.
  const hidden = [scenario.acceptance, "_cli.ts"].map((f) => join(repo, "tests", f));
  for (const f of hidden) if (existsSync(f)) renameSync(f, `${f}.hidden`);
  r.projectTestsPass = Bun.spawnSync(["bun", "test"], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exitCode === 0;
  for (const f of hidden) if (existsSync(`${f}.hidden`)) renameSync(`${f}.hidden`, f);

  const agents = Object.keys(scenario.features);
  r.ownFeatures = ownBranchFeatures(repo, agents, scenario.acceptance);
  r.overridden = agents.filter((a) => r.ownFeatures[a] && r.features[a] === false);
  r.silentOverrides = r.decisionRecorded ? 0 : r.overridden.length;
  r.conflictMarkers = conflictMarkersOnMain(repo);
  r.brokenMain = r.conflictMarkers || !r.projectTestsPass;
  const logFiles = r.mode === "remote"
    ? agents.map((a) => join(runsDir, d, `wt-${a}`, ".git", "agentsync", "log.jsonl"))
    : [join(repo, ".git", "agentsync", "log.jsonl")];
  const entries = logFiles.filter(existsSync).flatMap((f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const detection = r.mode === "baseline" ? { detected: 0, total: scenario.clashes.length } : detectedClashes(entries, scenario.clashes);
  r.clashesDetected = detection.detected;
  r.clashesTotal = detection.total;
  r.order ??= "";
  writeFileSync(resultFile, JSON.stringify(r));
  console.log(`${d}: success=${r.success} features=${JSON.stringify(r.features)}`);
}
